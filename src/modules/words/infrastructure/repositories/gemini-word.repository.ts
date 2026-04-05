import {
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { IWordRepository, WordFilters } from '../../domain/word.repository';
import { Word } from '../../domain/word.entity';
import { WordDifficulty } from '../../domain/word-difficulty.enum';
import { WordHistoryService } from '../services/word-history.service';
import { WordPoolService, WordPayload } from '../services/word-pool.service';
import { MockWordRepository } from './mock-word.repository';

/** Shape of each word object inside the batch response */
interface GeminiBatchItem {
    palabra_real: string;
    dificultad: string;
    categoria: string;
    pista_impostor: string[];
}

@Injectable()
export class GeminiWordRepository implements IWordRepository, OnModuleInit {
    private readonly logger = new Logger(GeminiWordRepository.name);
    private readonly genAI: GoogleGenerativeAI;

    private static readonly CATEGORIES = [
        'Animales', 'Comida', 'Deportes', 'Naturaleza', 'Transporte',
        'Tecnología', 'Hogar', 'Ropa', 'Profesiones', 'Lugares',
    ];

    /** Tamaño de cada lote pedido a Gemini */
    private static readonly BATCH_SIZE = 20;

    /** Cuántas palabras del historial enviar como muestra al prompt batch */
    private static readonly EXCLUSION_SAMPLE_SIZE = 30;

    /** Evita refills simultáneos */
    private refilling = false;

    constructor(
        private readonly config: ConfigService,
        private readonly wordHistory: WordHistoryService,
        private readonly pool: WordPoolService,
        private readonly fallback: MockWordRepository,
    ) {
        const apiKey = this.config.getOrThrow<string>('GEMINI_API_KEY');
        this.genAI = new GoogleGenerativeAI(apiKey);
    }

    /**
     * Al iniciar el módulo, si el pool está vacío, lanzamos un refill
     * desde Gemini en background para tener palabras listas cuanto antes.
     */
    async onModuleInit(): Promise<void> {
        const poolSize = await this.pool.size();
        if (poolSize === 0) {
            this.logger.log('[INIT] Pool vacío — disparando refill inicial desde Gemini...');
            this.refillFromGemini().catch((e) =>
                this.logger.error('[INIT] Refill inicial falló:', e instanceof Error ? e.message : e),
            );
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────────────

    async getRandomWord(filters?: WordFilters): Promise<Word | null> {
        // 1. Intentar sacar del pool
        let word = await this.pool.take(filters);

        // 2. Si pool vacío → refill sincrónico desde Gemini
        if (!word) {
            this.logger.log('[GEMINI] Pool vacío para estos filtros — llenando desde Gemini...');
            await this.refillFromGemini(filters);
            word = await this.pool.take(filters);
        }

        if (word) {
            await this.wordHistory.addWord(word.text);
            this.logger.log(`[POOL→WORD] "${word.text}" (${word.category} · ${word.difficulty})`);

            // 3. Background refill si el pool está bajo
            const remaining = await this.pool.size();
            if (remaining < WordPoolService.LOW_THRESHOLD && !this.refilling) {
                this.refillFromGemini().catch((e) =>
                    this.logger.error('[BG-REFILL] Falló:', e instanceof Error ? e.message : e),
                );
            }

            return word;
        }

        // 4. Último recurso: mock directo
        this.logger.warn('[FALLBACK] Usando mock directo.');
        const fallbackWord = await this.fallback.getRandomWord(filters);
        if (fallbackWord) {
            await this.wordHistory.addWord(fallbackWord.text);
        }
        return fallbackWord;
    }

    async getAllCategories(): Promise<string[]> {
        return GeminiWordRepository.CATEGORIES;
    }

    // ─── Refill batch desde Gemini ───────────────────────────────────────────────

    private async refillFromGemini(filters?: WordFilters): Promise<void> {
        if (this.refilling) {
            this.logger.log('[REFILL] Ya hay un refill en curso — omitiendo.');
            return;
        }
        this.refilling = true;

        try {
            const model = this.genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

            // Muestra de exclusión: solo las últimas N palabras usadas
            const allUsed = await this.wordHistory.getUsedWords();
            const sample = allUsed.slice(-GeminiWordRepository.EXCLUSION_SAMPLE_SIZE);

            const prompt = this.buildBatchPrompt(GeminiWordRepository.BATCH_SIZE, sample, filters);

            this.logger.log(`[REFILL] Pidiendo ${GeminiWordRepository.BATCH_SIZE} palabras a Gemini (muestra exclusión: ${sample.length})...`);

            const result = await model.generateContent(prompt);
            const rawText = result.response.text();
            this.logger.debug('[REFILL] Respuesta cruda:', rawText);

            const items = this.parseBatchResponse(rawText);

            const payloads: WordPayload[] = items.map((it) => ({
                text: it.palabra_real,
                category: it.categoria,
                difficulty: it.dificultad,
                impostorHints: it.pista_impostor,
            }));

            const added = await this.pool.addMany(payloads);
            this.logger.log(`[REFILL] ${added}/${items.length} palabras agregadas al pool (${items.length - added} descartadas por duplicados).`);
        } catch (error) {
            const message = error instanceof Error ? error.message : JSON.stringify(error);
            this.logger.error(`[REFILL] Error: ${message}`);
        } finally {
            this.refilling = false;
        }
    }

    // ─── Prompt batch ────────────────────────────────────────────────────────────

    private buildBatchPrompt(count: number, usedSample: string[], filters?: WordFilters): string {
        const exclusionLine =
            usedSample.length > 0
                ? usedSample.join(', ')
                : 'Ninguna todavía — eres libre de elegir cualquier palabra.';

        const difficultyLine = filters?.difficulty
            ? `- La dificultad DEBE ser exactamente: "${filters.difficulty}"`
            : '- Varía la dificultad entre los valores: "facil", "medio", "dificil"';

        const categoryLine = filters?.category
            ? `- La categoría DEBE ser exactamente: "${filters.category}"`
            : '- Varía las categorías (ej. Animales, Comida, Deportes, Transporte, Hogar, Tecnología, Ropa, Profesiones, Lugares, Naturaleza)';

        return `
Eres un diseñador experto del juego de mesa "El Impostor".
Tu tarea es generar ${count} palabras DISTINTAS, cada una con 5 pistas, para varias rondas del juego.

━━━ REGLAS DE CADA PALABRA ━━━
- Debe ser un sustantivo concreto, cotidiano y muy conocido en Latinoamérica (especialmente Venezuela).
- Prioriza objetos físicos del día a día: utensilios, alimentos, animales, medios de transporte, lugares comunes.
- EVITA: conceptos abstractos, términos científicos, arcaísmos o anglicismos poco usados.
- Ejemplos de palabras BUENAS: Nevera, Cambur, Moto, Arepa, Playa, Tijeras, Sartén.
- NINGUNA palabra del lote puede repetirse dentro del propio lote.
${difficultyLine}
${categoryLine}

━━━ MUESTRA DE PALABRAS RECIENTES — evítalas ━━━
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
  "palabras": [
    {
      "palabra_real": "string",
      "dificultad": "facil" | "medio" | "dificil",
      "categoria": "string",
      "pista_impostor": ["string", "string", "string", "string", "string"]
    }
  ]
}
`.trim();
    }

    // ─── Parseo batch ────────────────────────────────────────────────────────────

    private parseBatchResponse(raw: string): GeminiBatchItem[] {
        const cleaned = raw
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            this.logger.warn('[PARSE] Respuesta no es JSON válido:', raw);
            throw new Error('invalid_json');
        }

        const obj = parsed as Record<string, unknown>;

        // Puede venir como { palabras: [...] } o como array directo
        const arr: unknown[] = Array.isArray(obj)
            ? (obj as unknown[])
            : Array.isArray(obj.palabras)
                ? (obj.palabras as unknown[])
                : [];

        if (arr.length === 0) {
            this.logger.warn('[PARSE] Batch vacío o estructura inesperada.');
            throw new Error('empty_batch');
        }

        const valid: GeminiBatchItem[] = [];

        for (const item of arr) {
            try {
                const validated = this.validateBatchItem(item);
                if (validated) valid.push(validated);
            } catch {
                // Omitir ítems inválidos individualmente
            }
        }

        this.logger.log(`[PARSE] ${valid.length}/${arr.length} ítems válidos en el batch.`);
        return valid;
    }

    private validateBatchItem(item: unknown): GeminiBatchItem | null {
        const obj = item as Record<string, unknown>;

        if (
            typeof obj.palabra_real !== 'string' ||
            typeof obj.dificultad !== 'string' ||
            typeof obj.categoria !== 'string' ||
            !Array.isArray(obj.pista_impostor) ||
            obj.pista_impostor.length < 1
        ) {
            return null;
        }

        const hints = (obj.pista_impostor as unknown[]).map(String);
        const phrasesFound = hints.filter((h) => h.trim().includes(' '));
        if (phrasesFound.length > 0) {
            this.logger.debug(`Pistas con frases descartadas en "${obj.palabra_real}": ${phrasesFound.join(', ')}`);
            return null;
        }

        return {
            palabra_real: obj.palabra_real,
            dificultad: obj.dificultad,
            categoria: obj.categoria,
            pista_impostor: hints,
        };
    }
}
