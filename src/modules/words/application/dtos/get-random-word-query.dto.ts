import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WordDifficulty } from '../../domain/word-difficulty.enum';

export class GetRandomWordQueryDto {
    @ApiPropertyOptional({
        example: 'Animales',
        description: 'Filtra la palabra aleatoria por categoría. Si se omite, se elige de toda la colección.',
        minLength: 2,
    })
    @IsOptional()
    @IsString()
    @MinLength(2)
    category?: string;

    @ApiPropertyOptional({
        enum: WordDifficulty,
        example: WordDifficulty.EASY,
        description: 'Filtra por nivel de dificultad: facil, medio o dificil.',
    })
    @IsOptional()
    @IsEnum(WordDifficulty)
    difficulty?: WordDifficulty;
}
