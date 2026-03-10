import { Injectable } from '@nestjs/common';
import { IWordRepository } from '../../domain/word.repository';

@Injectable()
export class GetAllCategoriesUseCase {
    constructor(private readonly wordRepository: IWordRepository) { }

    async execute(): Promise<string[]> {
        return this.wordRepository.getAllCategories();
    }
}
