import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';
import { Word } from '../../domain/word.entity';
import { WordDifficulty } from '../../domain/word-difficulty.enum';
import { WordFilters } from '../../domain/word.repository';
import { WordHistoryService, normalizeWord } from './word-history.service';

/**
 * Forma serializable de una Word para guardarla en Redis.
 */
export interface WordPayload {
    text: string;
    category: string;
    difficulty: string;
    impostorHints: string[];
}

const POOL_KEY = 'words:pool';

/**
 * WordPoolService
 *
 * Pool de palabras pre-generadas guardado en una Redis LIST.
 * Cada entrada es un JSON string de WordPayload.
 *
 * El pool es llenado por:
 *  a) Semilla del catálogo mock (primera vez, si está vacío).
 *  b) Refills batch desde Gemini.
 *
 * Deduplica contra el historial de palabras usadas antes de agregar.
 */
@Injectable()
export class WordPoolService {
    private readonly logger = new Logger(WordPoolService.name);
    private readonly redis: Redis | null;
    private memoryPool: WordPayload[] = [];

    static readonly LOW_THRESHOLD = 8;

    constructor(
        private readonly config: ConfigService,
        private readonly history: WordHistoryService,
    ) {
        const url = this.config.get<string>('UPSTASH_REDIS_REST_URL');
        const token = this.config.get<string>('UPSTASH_REDIS_REST_TOKEN');

        if (url && token) {
            this.redis = new Redis({ url, token });
            this.logger.log('WordPoolService conectado a Upstash Redis.');
        } else {
            this.redis = null;
            this.logger.warn('WordPoolService sin Redis — pool en memoria.');
        }
    }

    async size(): Promise<number> {
        if (this.redis) {
            try {
                return await this.redis.llen(POOL_KEY);
            } catch {
                return this.memoryPool.length;
            }
        }
        return this.memoryPool.length;
    }

    /**
     * Extrae una palabra del pool que coincida con los filtros.
     * Retorna null si no hay ninguna que haga match.
     */
    async take(filters?: WordFilters): Promise<Word | null> {
        const items = await this.getAll();
        const idx = items.findIndex((w) => this.matches(w, filters));
        if (idx < 0) return null;

        const chosen = items[idx];
        await this.removeAt(idx);

        this.logger.log(`[POOL] Extraída "${chosen.text}" (${chosen.category}). Quedan ~${items.length - 1} en pool.`);
        return this.toDomain(chosen);
    }

    /**
     * Agrega varias palabras al pool, descartando las que ya están
     * en el historial o duplicadas dentro del mismo lote.
     * Retorna cuántas se agregaron efectivamente.
     */
    async addMany(words: WordPayload[]): Promise<number> {
        const seen = new Set<string>();
        const fresh: WordPayload[] = [];

        // También check de duplicados dentro del pool actual
        const current = await this.getAll();
        for (const w of current) seen.add(normalizeWord(w.text));

        for (const w of words) {
            const n = normalizeWord(w.text);
            if (!n || seen.has(n)) continue;
            if (await this.history.isUsed(w.text)) continue;
            seen.add(n);
            fresh.push(w);
        }

        if (fresh.length === 0) return 0;

        if (this.redis) {
            try {
                const serialized = fresh.map((f) => JSON.stringify(f));
                await this.redis.rpush(POOL_KEY, ...serialized);
            } catch (err) {
                this.logger.error('[POOL] Error al guardar en Redis, cayendo a memoria.', err);
                this.memoryPool.push(...fresh);
            }
        } else {
            this.memoryPool.push(...fresh);
        }

        this.logger.log(`[POOL] ${fresh.length} palabra(s) agregadas al pool.`);
        return fresh.length;
    }

    // ─── Privados ────────────────────────────────────────────────────────────────

    private async getAll(): Promise<WordPayload[]> {
        if (this.redis) {
            try {
                const raw = await this.redis.lrange(POOL_KEY, 0, -1);
                return raw.map((r) =>
                    typeof r === 'string' ? JSON.parse(r) : (r as WordPayload),
                );
            } catch {
                return [...this.memoryPool];
            }
        }
        return [...this.memoryPool];
    }

    private async removeAt(index: number): Promise<void> {
        if (this.redis) {
            try {
                // Redis no tiene LREMOVE-by-index nativo. Marcamos y limpiamos.
                const sentinel = `__DEL_${Date.now()}__`;
                await this.redis.lset(POOL_KEY, index, sentinel);
                await this.redis.lrem(POOL_KEY, 1, sentinel);
            } catch {
                // Fallback: reconstruir sin el elemento
                const all = await this.getAll();
                all.splice(index, 1);
                await this.rebuildList(all);
            }
        } else {
            this.memoryPool.splice(index, 1);
        }
    }

    private async rebuildList(items: WordPayload[]): Promise<void> {
        if (!this.redis) {
            this.memoryPool = items;
            return;
        }
        try {
            await this.redis.del(POOL_KEY);
            if (items.length > 0) {
                const serialized = items.map((i) => JSON.stringify(i));
                await this.redis.rpush(POOL_KEY, ...serialized);
            }
        } catch (err) {
            this.logger.error('[POOL] Error al reconstruir lista en Redis.', err);
        }
    }

    private matches(w: WordPayload, filters?: WordFilters): boolean {
        if (!filters) return true;
        if (filters.category && w.category.toLowerCase() !== filters.category.toLowerCase()) return false;
        if (filters.difficulty && this.mapDifficulty(w.difficulty) !== filters.difficulty) return false;
        return true;
    }

    private mapDifficulty(value: string): WordDifficulty {
        const map: Record<string, WordDifficulty> = {
            facil: WordDifficulty.EASY,
            fácil: WordDifficulty.EASY,
            medio: WordDifficulty.MEDIUM,
            media: WordDifficulty.MEDIUM,
            dificil: WordDifficulty.HARD,
            difícil: WordDifficulty.HARD,
        };
        return map[value.toLowerCase()] ?? WordDifficulty.EASY;
    }

    private toDomain(w: WordPayload): Word {
        return new Word(
            crypto.randomUUID(),
            w.text,
            w.category,
            this.mapDifficulty(w.difficulty),
            w.impostorHints,
        );
    }
}
