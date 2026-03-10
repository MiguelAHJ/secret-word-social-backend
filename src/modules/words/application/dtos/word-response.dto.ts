import { ApiProperty } from '@nestjs/swagger';
import { Word } from '../../domain/word.entity';
import { WordDifficulty } from '../../domain/word-difficulty.enum';

export class WordResponseDto {
    @ApiProperty({ example: '1', description: 'Identificador único de la palabra' })
    id: string;

    @ApiProperty({ example: 'Perro', description: 'La palabra secreta que verán los jugadores normales' })
    text: string;

    @ApiProperty({ example: 'Animales', description: 'Categoría temática a la que pertenece la palabra' })
    category: string;

    @ApiProperty({
        enum: WordDifficulty,
        example: WordDifficulty.EASY,
        description: 'Nivel de dificultad de la palabra',
    })
    difficulty: WordDifficulty;

    @ApiProperty({
        type: [String],
        example: ['Vecino', 'Ruido', 'Paseo', 'Puerta', 'Lealtad'],
        description:
            'Lista de palabras relacionadas que recibe el impostor en lugar de la palabra real. ' +
            'El módulo de partidas debe enviar este array al impostor y la palabra real a los demás.',
    })
    impostorHints: string[];

    static fromEntity(word: Word): WordResponseDto {
        const dto = new WordResponseDto();
        dto.id = word.id;
        dto.text = word.text;
        dto.category = word.category;
        dto.difficulty = word.difficulty;
        dto.impostorHints = word.impostorHints;
        return dto;
    }
}
