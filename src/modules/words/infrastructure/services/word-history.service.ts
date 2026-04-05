import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';

const REDIS_KEY = 'used_words';

/**
 * Normaliza una palabra para comparaciones de historial:
 *  - minúsculas
 *  - sin acentos / diacríticos (NFD + strip)
 *  - sin espacios al borde
 *
 * Exportada para que otros servicios (ej. WordPoolService) usen
 * exactamente la misma regla de comparación.
 */
export function normalizeWord(word: string): string {
    return word
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/**
 * WordHistoryService
 *
 * Persiste en Upstash Redis la lista de palabras ya generadas para
 * evitar repeticiones entre rondas. Usa un Redis Set para unicidad
 * y operaciones O(1). Mantiene además una vista normalizada en memoria
 * para chequeos rápidos de duplicados sin tildes / mayúsculas.
 *
 * Si las variables de Upstash no están configuradas, opera solo en
 * memoria (útil para desarrollo local sin Redis).
 */
@Injectable()
export class WordHistoryService {
    private readonly logger = new Logger(WordHistoryService.name);
    private readonly redis: Redis | null;

    // Cache en memoria para no hacer round-trip a Redis en cada petición
    private cache: string[] | null = null;
    private normalizedCache: Set<string> | null = null;

    constructor(private readonly config: ConfigService) {
        const url = this.config.get<string>('UPSTASH_REDIS_REST_URL');
        const token = this.config.get<string>('UPSTASH_REDIS_REST_TOKEN');

        if (url && token) {
            this.redis = new Redis({ url, token });
            this.logger.log('WordHistoryService conectado a Upstash Redis.');
        } else {
            this.redis = null;
            this.logger.warn('UPSTASH_REDIS_REST_URL o TOKEN no configurados. Historial solo en memoria.');
        }
    }

    async getUsedWords(): Promise<string[]> {
        if (this.cache !== null) {
            return this.cache;
        }

        if (this.redis) {
            try {
                this.logger.log('[HISTORY] Cache vacía — consultando Upstash Redis...');
                const members = await this.redis.smembers(REDIS_KEY);
                this.cache = members as string[];
                this.rebuildNormalized();
                this.logger.log(`[HISTORY] Redis OK — ${this.cache.length} palabra(s) en historial.`);
            } catch (err) {
                this.logger.error('[HISTORY] Error al leer historial de Redis. Se usará lista vacía.', err instanceof Error ? err.message : JSON.stringify(err));
                this.cache = [];
                this.normalizedCache = new Set();
            }
        } else {
            this.logger.warn('[HISTORY] Sin conexión a Redis — historial en memoria vacío (arranque fresco).');
            this.cache = [];
            this.normalizedCache = new Set();
        }

        return this.cache;
    }

    /**
     * ¿La palabra ya fue usada? Compara normalizado (sin acentos ni caps).
     * Barato: O(1) contra el Set en memoria.
     */
    async isUsed(word: string): Promise<boolean> {
        await this.getUsedWords(); // asegura caches hidratados
        return this.normalizedCache!.has(normalizeWord(word));
    }

    async addWord(word: string): Promise<void> {
        await this.addMany([word]);
    }

    /**
     * Agrega varias palabras en un solo round-trip a Redis.
     * Filtra duplicados locales (normalizados) antes de persistir.
     */
    async addMany(words: string[]): Promise<void> {
        await this.getUsedWords();

        const fresh: string[] = [];
        for (const w of words) {
            const n = normalizeWord(w);
            if (!n) continue;
            if (this.normalizedCache!.has(n)) continue;
            this.normalizedCache!.add(n);
            this.cache!.push(w);
            fresh.push(w);
        }

        if (fresh.length === 0) return;

        if (this.redis) {
            try {
                await this.redis.sadd(REDIS_KEY, fresh[0], ...fresh.slice(1));
                this.logger.log(`[HISTORY] ${fresh.length} palabra(s) añadidas al historial. Total: ${this.cache!.length}`);
            } catch (err) {
                this.logger.error(`[HISTORY] Error al guardar en Redis.`, err instanceof Error ? err.message : JSON.stringify(err));
            }
        } else {
            this.logger.warn(`[HISTORY] Sin Redis — ${fresh.length} palabra(s) guardadas solo en memoria.`);
        }
    }

    async getSize(): Promise<number> {
        const list = await this.getUsedWords();
        return list.length;
    }

    async clearHistory(): Promise<void> {
        this.cache = [];
        this.normalizedCache = new Set();
        if (this.redis) {
            try {
                await this.redis.del(REDIS_KEY);
            } catch (err) {
                this.logger.error('Error al limpiar historial en Redis:', err);
            }
        }
    }

    private rebuildNormalized(): void {
        this.normalizedCache = new Set((this.cache ?? []).map(normalizeWord));
    }
}
