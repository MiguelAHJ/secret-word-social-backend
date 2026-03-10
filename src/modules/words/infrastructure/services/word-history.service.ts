import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

interface WordHistoryFile {
    usedWords: string[];
}

/**
 * WordHistoryService
 *
 * Persiste en disco la lista de palabras ya generadas por la IA para
 * incluirlas en el prompt de Gemini como "lista de exclusión".
 *
 * Archivo: <project_root>/data/used_words.json
 */
@Injectable()
export class WordHistoryService {
    private readonly logger = new Logger(WordHistoryService.name);
    private readonly filePath = path.join(process.cwd(), 'data', 'used_words.json');

    // Cache en memoria para no releer el disco en cada petición
    private cache: string[] | null = null;

    getUsedWords(): string[] {
        if (this.cache !== null) return this.cache;

        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed: WordHistoryFile = JSON.parse(raw);
            this.cache = parsed.usedWords ?? [];
        } catch {
            this.logger.warn('No se pudo leer used_words.json, iniciando con lista vacía.');
            this.cache = [];
        }

        return this.cache;
    }

    addWord(word: string): void {
        const list = this.getUsedWords();

        if (list.includes(word)) return;

        list.push(word);
        this.cache = list;

        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const data: WordHistoryFile = { usedWords: list };
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (err) {
            this.logger.error('Error al escribir used_words.json', err);
        }
    }

    /** Útil para testing o para resetear el historial manualmente */
    clearHistory(): void {
        this.cache = [];
        const data: WordHistoryFile = { usedWords: [] };
        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
}
