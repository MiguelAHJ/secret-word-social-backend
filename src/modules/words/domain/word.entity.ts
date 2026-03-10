import { WordDifficulty } from './word-difficulty.enum';

export class Word {
    constructor(
        public readonly id: string,
        public readonly text: string,
        public readonly category: string,
        public readonly difficulty: WordDifficulty,
        /** List of single related words shown to the impostor instead of the real word */
        public readonly impostorHints: string[],
    ) { }
}
