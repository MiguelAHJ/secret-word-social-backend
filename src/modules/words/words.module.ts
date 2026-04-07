import { Module } from '@nestjs/common';
import { WordsController } from './infrastructure/controllers/words.controller';
import { GetRandomWordUseCase } from './application/use-cases/get-random-word.use-case';
import { GetAllCategoriesUseCase } from './application/use-cases/get-all-categories.use-case';
import { IWordRepository } from './domain/word.repository';
import { GeminiWordRepository } from './infrastructure/repositories/gemini-word.repository';
import { MockWordRepository } from './infrastructure/repositories/mock-word.repository';
import { WordHistoryService } from './infrastructure/services/word-history.service';
import { WordPoolService } from './infrastructure/services/word-pool.service';

@Module({
    controllers: [WordsController],
    providers: [
        WordHistoryService,
        WordPoolService,
        MockWordRepository,
        GetRandomWordUseCase,
        GetAllCategoriesUseCase,
        {
            provide: IWordRepository,
            useClass: GeminiWordRepository,
        },
    ],
    exports: [GetRandomWordUseCase],
})
export class WordsModule { }
