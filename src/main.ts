import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // --- Global prefix ---
  // All routes will be prefixed with /api/v1 (e.g. GET /api/v1/words/random).
  // This makes versioning and future gateway routing easy.
  app.setGlobalPrefix('api/v1');

  // --- Validation ---
  // Strips unknown properties and auto-transforms query/body to their DTO types.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // --- Exception filter ---
  app.useGlobalFilters(new GlobalExceptionFilter());

  // --- Swagger ---
  const config = new DocumentBuilder()
    .setTitle('Impostor Game API')
    .setDescription(
      'REST API para el juego El Impostor. Gestiona palabras, pistas y categorías.',
    )
    .setVersion('1.0')
    .addTag('words', 'Gestión de palabras y categorías del juego')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'Impostor API Docs',
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
