import { Module } from '@nestjs/common';
import { WordsController } from './infrastructure/controllers/words.controller';
import { GetRandomWordUseCase } from './application/use-cases/get-random-word.use-case';
import { GetAllCategoriesUseCase } from './application/use-cases/get-all-categories.use-case';
import { IWordRepository } from './domain/word.repository';
import { GeminiWordRepository } from './infrastructure/repositories/gemini-word.repository';
import { MockWordRepository } from './infrastructure/repositories/mock-word.repository';
import { WordHistoryService } from './infrastructure/services/word-history.service';

/**
 * WordsModule
 *
 * Para cambiar la implementación del repositorio:
 *   • IA Generativa  → useClass: GeminiWordRepository  (activo)
 *   • Datos estáticos → useClass: MockWordRepository     (comentado)
 *   • Base de datos   → useClass: SqlWordRepository      (futuro)
 *
 * MockWordRepository también se registra como provider independiente
 * para que GeminiWordRepository pueda usarlo como fallback automático.
 */
@Module({
    controllers: [WordsController],
    providers: [
        WordHistoryService,
        MockWordRepository,
        GetRandomWordUseCase,
        GetAllCategoriesUseCase,
        {
            provide: IWordRepository,
            useClass: GeminiWordRepository,
            // useClass: MockWordRepository,
        },
    ],
})
export class WordsModule { }
