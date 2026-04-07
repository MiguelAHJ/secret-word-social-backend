import { Module } from '@nestjs/common';
import { RoomGateway } from './room.gateway';
import { RoomService } from './room.service';
import { WordsModule } from '../words/words.module';

@Module({
  imports: [WordsModule],
  providers: [RoomGateway, RoomService],
})
export class RoomsModule {}
