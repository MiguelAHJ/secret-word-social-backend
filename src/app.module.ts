import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WordsModule } from './modules/words/words.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // ConfigService disponible en TODOS los módulos sin importarlo de nuevo
      envFilePath: '.env',
    }),
    WordsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
