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
        if (this.cache !== null) return this.cache;

        if (this.redis) {
            try {
                const members = await this.redis.smembers(REDIS_KEY);
                this.cache = members as string[];
            } catch (err) {
                this.logger.error('Error al leer historial de Redis:', err);
                this.cache = [];
            }
        } else {
            this.cache = [];
        }

        return this.cache;
    }

    async addWord(word: string): Promise<void> {
        const list = await this.getUsedWords();

        if (list.includes(word)) return;

        list.push(word);
        this.cache = list;

        if (this.redis) {
            try {
                await this.redis.sadd(REDIS_KEY, word);
            } catch (err) {
                this.logger.error('Error al guardar palabra en Redis:', err);
            }
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
