import { Controller, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiOkResponse,
    ApiNotFoundResponse,
    ApiBadRequestResponse,
} from '@nestjs/swagger';
import { GetRandomWordUseCase } from '../../application/use-cases/get-random-word.use-case';
import { GetAllCategoriesUseCase } from '../../application/use-cases/get-all-categories.use-case';
import { GetRandomWordQueryDto } from '../../application/dtos/get-random-word-query.dto';
import { WordResponseDto } from '../../application/dtos/word-response.dto';

@ApiTags('words')
@Controller('words')
export class WordsController {
    constructor(
        private readonly getRandomWordUseCase: GetRandomWordUseCase,
        private readonly getAllCategoriesUseCase: GetAllCategoriesUseCase,
    ) { }

    @ApiOperation({
        summary: 'Obtener una palabra aleatoria',
        description:
            'Devuelve una palabra aleatoria de la colección. ' +
            'Incluye la pista del impostor (`impostorHint`) para que el módulo de partidas ' +
            'decida qué enviar a cada jugador según su rol.',
    })
    @ApiOkResponse({ type: WordResponseDto, description: 'Palabra encontrada exitosamente' })
    @ApiNotFoundResponse({ description: 'No existen palabras para la categoría especificada' })
    @ApiBadRequestResponse({ description: 'El parámetro category no cumple las validaciones' })
    @Get('random')
    @HttpCode(HttpStatus.OK)
    async getRandomWord(
        @Query() query: GetRandomWordQueryDto,
    ): Promise<WordResponseDto> {
        const word = await this.getRandomWordUseCase.execute({
            category: query.category,
            difficulty: query.difficulty,
        });
        return WordResponseDto.fromEntity(word);
    }

    @ApiOperation({
        summary: 'Listar todas las categorías',
        description: 'Devuelve el listado completo de categorías disponibles en la colección de palabras.',
    })
    @ApiOkResponse({
        schema: {
            type: 'array',
            items: { type: 'string', example: 'Animales' },
            example: ['Animales', 'Comida', 'Deportes'],
        },
        description: 'Lista de categorías únicas',
    })
    @Get('categories')
    @HttpCode(HttpStatus.OK)
    async getAllCategories(): Promise<string[]> {
        return this.getAllCategoriesUseCase.execute();
    }
}
