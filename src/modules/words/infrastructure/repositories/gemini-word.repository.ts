import {
    Injectable,
    Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IWordRepository, WordFilters } from '../../domain/word.repository';
import { Word } from '../../domain/word.entity';
import { WordDifficulty } from '../../domain/word-difficulty.enum';
import { WordHistoryService } from '../services/word-history.service';
import { MockWordRepository } from './mock-word.repository';

/** Shape of the JSON object we expect from Gemini */
interface GeminiWordResponse {
    palabra_real: string;
    dificultad: string;
    categoria: string;
    pista_impostor: string[];
}

@Injectable()
export class GeminiWordRepository implements IWordRepository {
    private readonly logger = new Logger(GeminiWordRepository.name);
    private readonly genAI: GoogleGenerativeAI;

    /** Categorías disponibles — Gemini puede generar cualquiera, pero estas son las que el cliente conoce */
    private static readonly CATEGORIES = [
        'Animales',
        'Comida',
        'Deportes',
        'Naturaleza',
        'Transporte',
        'Tecnología',
        'Hogar',
        'Ropa',
        'Profesiones',
        'Lugares',
    ];

    constructor(
        private readonly config: ConfigService,
        private readonly wordHistory: WordHistoryService,
        private readonly fallback: MockWordRepository,
    ) {
        const apiKey = this.config.getOrThrow<string>('GEMINI_API_KEY');
        this.genAI = new GoogleGenerativeAI(apiKey);
    }

    private static readonly MAX_RETRIES = 3;

    async getRandomWord(filters?: WordFilters): Promise<Word | null> {
        const usedWords = await this.wordHistory.getUsedWords();

        this.logger.log(`[GEMINI] Solicitando palabra. Historial de exclusión: ${usedWords.length} palabra(s) — [${usedWords.join(', ') || 'ninguna'}]`);

        const model = this.genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

        for (let attempt = 1; attempt <= GeminiWordRepository.MAX_RETRIES; attempt++) {
            const prompt = this.buildPrompt(usedWords, filters);

            try {
                const result = await model.generateContent(prompt);
                const rawText = result.response.text();

                this.logger.debug('Respuesta cruda de Gemini:', rawText);

                const parsed = this.parseGeminiResponse(rawText);

                const normalizedResponse = parsed.palabra_real.trim().toLowerCase();
                const isDuplicate = usedWords.some((w) => w.trim().toLowerCase() === normalizedResponse);

                if (isDuplicate) {
                    this.logger.warn(`[GEMINI] Intento ${attempt}/${GeminiWordRepository.MAX_RETRIES}: Gemini devolvió "${parsed.palabra_real}" que ya está en el historial. Reintentando...`);
                    // Añadir la palabra repetida como contexto extra para el siguiente intento
                    usedWords.push(parsed.palabra_real);
                    continue;
                }

                const word = new Word(
                    crypto.randomUUID(),
                    parsed.palabra_real,
                    parsed.categoria,
                    this.mapDifficulty(parsed.dificultad),
                    parsed.pista_impostor,
                );

                await this.wordHistory.addWord(parsed.palabra_real);

                this.logger.log(`[GEMINI] Palabra generada en intento ${attempt}: "${word.text}" (${word.category} · ${word.difficulty})`);

                return word;
            } catch (error) {
                const message = error instanceof Error ? error.message : JSON.stringify(error);
                this.logger.error(`[GEMINI] Intento ${attempt}/${GeminiWordRepository.MAX_RETRIES} falló: ${message}`);
                if (error instanceof Error && error.cause) {
                    this.logger.error(`Causa: ${JSON.stringify(error.cause)}`);
                }

                if (attempt < GeminiWordRepository.MAX_RETRIES) continue;
            }
        }

        this.logger.warn(`[GEMINI] Agotados ${GeminiWordRepository.MAX_RETRIES} intentos. Usando fallback con datos locales.`);
        const fallbackWord = await this.fallback.getRandomWord(filters);
        if (fallbackWord) {
            this.logger.warn(`[FALLBACK] Palabra del mock: "${fallbackWord.text}" (${fallbackWord.category} · ${fallbackWord.difficulty})`);
        }
        return fallbackWord;
    }

    async getAllCategories(): Promise<string[]> {
        return GeminiWordRepository.CATEGORIES;
    }

    // ─── Private helpers ────────────────────────────────────────────────────────

    private buildPrompt(usedWords: string[], filters?: WordFilters): string {
        const exclusionLine =
            usedWords.length > 0
                ? usedWords.join(', ')
                : 'Ninguna todavía — eres libre de elegir cualquier palabra.';

        const difficultyLine = filters?.difficulty
            ? `- La dificultad DEBE ser exactamente: "${filters.difficulty}"`
            : '- Elige la dificultad libremente entre los valores: "facil", "medio", "dificil"';

        const categoryLine = filters?.category
            ? `- La categoría DEBE ser exactamente: "${filters.category}"`
            : '- Elige la categoría libremente (ej. Animales, Comida, Deportes, Transporte, Hogar, etc.)';

        return `
Eres un diseñador experto del juego de mesa "El Impostor".
Tu tarea es generar UNA sola palabra y 5 pistas para una ronda del juego.

━━━ REGLAS DE LA PALABRA ━━━
- Debe ser un sustantivo concreto, cotidiano y muy conocido en Latinoamérica (especialmente Venezuela).
- Prioriza objetos físicos del día a día: utensilios, alimentos, animales, medios de transporte, lugares comunes.
- EVITA: conceptos abstractos, términos científicos, arcaísmos o anglicismos poco usados.
- Ejemplos de palabras BUENAS: Nevera, Cambur, Moto, Arepa, Playa, Tijeras, Sartén.
${difficultyLine}
${categoryLine}

━━━ PALABRAS YA USADAS — NO repitas ninguna ━━━
${exclusionLine}

━━━ REGLAS DE LAS PISTAS (pista_impostor) ━━━
⚠️  REGLA ABSOLUTA: Cada pista debe ser UNA SOLA PALABRA. Sin artículos, sin frases, sin adjetivos compuestos.
    Si una pista tiene más de una palabra → la respuesta es INVÁLIDA.

Las pistas deben cumplir TODAS estas condiciones:

1. UNA PALABRA: sustantivo, adjetivo o verbo en infinitivo. Ejemplos válidos: "Pelaje", "Metálica", "Recoger".
   Ejemplos INVÁLIDOS: "Tiene pelaje", "Es metálica", "Sirve para recoger". ← FRASES PROHIBIDAS.

2. CARACTERÍSTICAS PROPIAS: Cada pista debe describir una propiedad FÍSICA, SENSORIAL o FUNCIONAL
   directa del objeto (forma, material, textura, sonido, acción principal, partes).
   NUNCA el contexto social o el lugar donde se usa.

3. INDIRECTAS PERO JUSTAS: El impostor que las lea debe poder intuir la categoría general,
   pero NO adivinar la palabra exacta.

4. PRUEBA MENTAL antes de incluir cada pista: pregúntate
   "¿esta palabra describe algo PROPIO del objeto, o solo el ENTORNO donde aparece?"
   Si es entorno → DESCÁRTALA.

EJEMPLOS PARA CALIBRAR:
✗ MALO  → "Cuchara" / ["Tiene una parte cóncava","Suele ser metálica","Sirve para recoger","Posee un mango","Es útil para mezclar"]
          SON FRASES. Completamente prohibido.
✓ BUENO → "Cuchara" / ["Cóncava","Metálica","Mango","Líquido","Soplar"]

✗ MALO  → "Mesa" / ["Madera","Patas","Familia","Comida","Jugar"]
          "Familia" y "Jugar" describen ENTORNO, no el objeto.
✓ BUENO → "Mesa" / ["Superficie","Tablero","Plana","Apoyo","Bordes"]

✗ MALO  → "Perro" / ["Ladrar","Canino","Mascota","Collar","Correa"]
          "Canino" y "Mascota" nombran al objeto casi directamente.
✓ BUENO → "Perro" / ["Pelaje","Olfato","Colmillo","Correr","Leal"]

FORMATO DE RESPUESTA:
Responde ÚNICAMENTE con el objeto JSON puro. SIN bloques markdown, SIN texto adicional.

{
  "palabra_real": "string",
  "dificultad": "facil" | "medio" | "dificil",
  "categoria": "string",
  "pista_impostor": ["string", "string", "string", "string", "string"]
}
`.trim();
    }

    private parseGeminiResponse(raw: string): GeminiWordResponse {
        // Gemini a veces envuelve la respuesta en ```json … ``` — lo eliminamos
        const cleaned = raw
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            this.logger.warn('Respuesta de Gemini no es JSON válido:', raw);
            throw new Error('invalid_json');
        }

        const obj = parsed as Record<string, unknown>;

        if (
            typeof obj.palabra_real !== 'string' ||
            typeof obj.dificultad !== 'string' ||
            typeof obj.categoria !== 'string' ||
            !Array.isArray(obj.pista_impostor) ||
            obj.pista_impostor.length < 1
        ) {
            this.logger.warn('JSON de Gemini con estructura inválida:', parsed);
            throw new Error('invalid_structure');
        }

        const hints = (obj.pista_impostor as unknown[]).map(String);
        const phrasesFound = hints.filter((h) => h.trim().includes(' '));
        if (phrasesFound.length > 0) {
            this.logger.warn('Gemini devolvió frases en lugar de palabras:', phrasesFound);
            throw new Error('hints_are_phrases');
        }

        return {
            palabra_real: obj.palabra_real,
            dificultad: obj.dificultad,
            categoria: obj.categoria,
            pista_impostor: hints,
        };
    }

    /** Normaliza la dificultad que devuelve Gemini a nuestro enum */
    private mapDifficulty(value: string): WordDifficulty {
        const map: Record<string, WordDifficulty> = {
            facil: WordDifficulty.EASY,
            fácil: WordDifficulty.EASY,
            medio: WordDifficulty.MEDIUM,
            media: WordDifficulty.MEDIUM,
            intermedia: WordDifficulty.MEDIUM,
            intermedio: WordDifficulty.MEDIUM,
            dificil: WordDifficulty.HARD,
            difícil: WordDifficulty.HARD,
        };
        return map[value.toLowerCase()] ?? WordDifficulty.EASY;
    }
}
