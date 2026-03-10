import { Word } from './word.entity';
import { WordDifficulty } from './word-difficulty.enum';

/**
 * Port (Dependency Inversion Principle).
 * The Application layer depends on this abstraction, never on concrete implementations.
 */

export interface WordFilters {
    category?: string;
    difficulty?: WordDifficulty;
}

export abstract class IWordRepository {
    abstract getRandomWord(filters?: WordFilters): Promise<Word | null>;
    abstract getAllCategories(): Promise<string[]>;
}
