import { Injectable, NotFoundException } from '@nestjs/common';
import { IWordRepository, WordFilters } from '../../domain/word.repository';
import { Word } from '../../domain/word.entity';

@Injectable()
export class GetRandomWordUseCase {
    constructor(private readonly wordRepository: IWordRepository) { }

    async execute(filters?: WordFilters): Promise<Word> {
        const word = await this.wordRepository.getRandomWord(filters);

        if (!word) {
            const parts: string[] = [];
            if (filters?.category) parts.push(`categoría "${filters.category}"`);
            if (filters?.difficulty) parts.push(`dificultad "${filters.difficulty}"`);

            throw new NotFoundException(
                parts.length
                    ? `No se encontraron palabras para ${parts.join(' y ')}`
                    : 'No hay palabras disponibles',
            );
        }

        return word;
    }
}
