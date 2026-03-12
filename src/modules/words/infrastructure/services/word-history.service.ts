import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';

const REDIS_KEY = 'used_words';

/**
 * WordHistoryService
 *
 * Persiste en Upstash Redis la lista de palabras ya generadas por la IA
 * para incluirlas en el prompt de Gemini como "lista de exclusión".
 *
 * Usa un Redis Set para garantizar unicidad y operaciones O(1).
 * Si las variables de Upstash no están configuradas, opera solo en memoria
 * (útil para desarrollo local sin Redis).
 */
@Injectable()
export class WordHistoryService {
    private readonly logger = new Logger(WordHistoryService.name);
    private readonly redis: Redis | null;

    // Cache en memoria para no hacer round-trip a Redis en cada petición
    private cache: string[] | null = null;

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
            this.logger.log(`[HISTORY] Cache en memoria activa — ${this.cache.length} palabra(s) cargadas.`);
            return this.cache;
        }

        if (this.redis) {
            try {
                this.logger.log('[HISTORY] Cache vacía — consultando Upstash Redis...');
                const members = await this.redis.smembers(REDIS_KEY);
                this.cache = members as string[];
                this.logger.log(`[HISTORY] Redis OK — ${this.cache.length} palabra(s) en historial: [${this.cache.join(', ') || 'vacío'}]`);
            } catch (err) {
                this.logger.error('[HISTORY] Error al leer historial de Redis. Se usará lista vacía.', err instanceof Error ? err.message : JSON.stringify(err));
                this.cache = [];
            }
        } else {
            this.logger.warn('[HISTORY] Sin conexión a Redis — historial en memoria vacío (arranque fresco).');
            this.cache = [];
        }

        return this.cache;
    }

    async addWord(word: string): Promise<void> {
        const list = await this.getUsedWords();

        if (list.includes(word)) {
            this.logger.log(`[HISTORY] "${word}" ya existe en el historial — se omite.`);
            return;
        }

        list.push(word);
        this.cache = list;

        if (this.redis) {
            try {
                await this.redis.sadd(REDIS_KEY, word);
                this.logger.log(`[HISTORY] "${word}" guardada en Redis correctamente. Total: ${list.length}`);
            } catch (err) {
                this.logger.error(`[HISTORY] Error al guardar "${word}" en Redis. La palabra quedó solo en memoria.`, err instanceof Error ? err.message : JSON.stringify(err));
            }
        } else {
            this.logger.warn(`[HISTORY] Sin Redis — "${word}" guardada solo en memoria (se perderá al reiniciar).`);
        }
    }

    async clearHistory(): Promise<void> {
        this.cache = [];
        if (this.redis) {
            try {
                await this.redis.del(REDIS_KEY);
            } catch (err) {
                this.logger.error('Error al limpiar historial en Redis:', err);
            }
        }
    }
}
