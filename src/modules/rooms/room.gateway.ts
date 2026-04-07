import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from './room.service';
import { RoomSettings } from './room.types';
import { GetRandomWordUseCase } from '../words/application/use-cases/get-random-word.use-case';

@WebSocketGateway({ cors: { origin: '*' } })
export class RoomGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RoomGateway.name);

  /** Active countdown timers keyed by room code */
  private readonly countdownTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly roomService: RoomService,
    private readonly getRandomWord: GetRandomWordUseCase,
  ) {}

  // ── Create room ───────────────────────────────────────────────────────────

  @SubscribeMessage('create_room')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerName: string },
  ) {
    const room = this.roomService.createRoom(client.id, data.playerName);
    client.join(room.code);
    client.emit('room_created', this.serializeRoom(room));
    this.logger.log(`create_room → ${room.code} by "${data.playerName}"`);
  }

  // ── Join room ─────────────────────────────────────────────────────────────

  @SubscribeMessage('join_room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string; playerName: string },
  ) {
    const result = this.roomService.joinRoom(
      data.roomCode.toUpperCase(),
      client.id,
      data.playerName,
    );

    if ('error' in result) {
      client.emit('room_error', { message: result.error });
      return;
    }

    client.join(result.code);
    this.server.to(result.code).emit('room_updated', this.serializeRoom(result));
    this.logger.log(`join_room → ${result.code} by "${data.playerName}"`);
  }

  // ── Update settings (host only) ───────────────────────────────────────────

  @SubscribeMessage('update_settings')
  handleUpdateSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string; settings: Partial<RoomSettings> },
  ) {
    const room = this.roomService.updateSettings(
      data.roomCode,
      client.id,
      data.settings,
    );
    if (!room) return;

    // Cancel any running countdown since settings changed
    this.cancelCountdown(room.code);

    this.server.to(room.code).emit('room_updated', this.serializeRoom(room));
  }

  // ── Toggle ready ──────────────────────────────────────────────────────────

  @SubscribeMessage('toggle_ready')
  handleToggleReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const room = this.roomService.toggleReady(data.roomCode, client.id);
    if (!room) return;

    this.server.to(room.code).emit('room_updated', this.serializeRoom(room));

    // Check if all players are ready → start countdown
    if (this.roomService.allReady(room.code)) {
      this.startCountdown(room.code);
    } else {
      this.cancelCountdown(room.code);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  handleDisconnect(client: Socket) {
    const result = this.roomService.removePlayer(client.id);
    if (!result) return;

    const { room, removed } = result;
    this.logger.log(`disconnect → "${removed.name}" left ${room.code}`);

    if (room.players.length === 0) {
      this.cancelCountdown(room.code);
      return;
    }

    this.cancelCountdown(room.code);
    this.server.to(room.code).emit('room_updated', this.serializeRoom(room));
  }

  // ── Leave room (voluntary) ────────────────────────────────────────────────

  @SubscribeMessage('leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    const result = this.roomService.removePlayer(client.id);
    if (!result) return;

    const { room, removed } = result;
    client.leave(room.code);
    client.emit('room_left');

    if (room.players.length > 0) {
      this.cancelCountdown(room.code);
      this.server.to(room.code).emit('room_updated', this.serializeRoom(room));
    }

    this.logger.log(`leave_room → "${removed.name}" left ${room.code}`);
  }

  // ── Countdown logic ───────────────────────────────────────────────────────

  private startCountdown(roomCode: string) {
    this.cancelCountdown(roomCode);

    let seconds = 5;
    this.roomService.setCountdown(roomCode, seconds);
    this.server.to(roomCode).emit('countdown', { seconds });

    const timer = setInterval(() => {
      seconds--;

      if (seconds <= 0) {
        this.cancelCountdown(roomCode);
        this.roomService.setCountdown(roomCode, null);
        void this.emitGameStarting(roomCode);
        return;
      }

      this.roomService.setCountdown(roomCode, seconds);
      this.server.to(roomCode).emit('countdown', { seconds });
    }, 1000);

    this.countdownTimers.set(roomCode, timer);
  }

  private async emitGameStarting(roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    if (!room) return;

    const word = await this.getRandomWord.execute();
    const clue = word.impostorHints[Math.floor(Math.random() * word.impostorHints.length)];

    const playerNames = room.players.map((p) => p.name);
    const shuffled = [...playerNames].sort(() => Math.random() - 0.5);
    const impostorNames = new Set(shuffled.slice(0, room.settings.impostorCount));

    const assignments = room.players.map((p) => ({
      name: p.name,
      role: impostorNames.has(p.name) ? 'impostor' : 'civil',
    }));

    const firstSpeaker = playerNames[Math.floor(Math.random() * playerNames.length)];

    this.roomService.initGame(roomCode, playerNames, firstSpeaker);

    this.server.to(roomCode).emit('game_starting', {
      word: word.text,
      clue,
      assignments,
      firstSpeaker,
      impostorCount: room.settings.impostorCount,
      showRoleOnElimination: room.settings.showRoleOnElimination,
      impostorHasClue: room.settings.impostorHasClue,
    });

    this.logger.log(`Sala ${roomCode} → game_starting (${assignments.length} jugadores)`);

    // After 10s reveal phase, start discussion
    setTimeout(() => {
      this.emitDiscussionStarted(roomCode);
    }, 10_000);
  }

  private emitDiscussionStarted(roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    if (!room || room.alivePlayers.length === 0) return;

    const speakingOrder = this.buildSpeakingOrder(room.alivePlayers, room.firstSpeaker);
    const deadlineMs = Date.now() + 300_000; // 5 minutes

    this.server.to(roomCode).emit('discussion_started', {
      speakingOrder,
      roundNumber: room.roundNumber,
      deadlineMs,
    });

    this.logger.log(`Sala ${roomCode} → discussion_started (ronda ${room.roundNumber})`);
  }

  private buildSpeakingOrder(alivePlayers: string[], firstSpeaker: string): string[] {
    const idx = alivePlayers.indexOf(firstSpeaker);
    if (idx === -1) return [...alivePlayers];
    return [...alivePlayers.slice(idx), ...alivePlayers.slice(0, idx)];
  }

  // ── Voting handlers ───────────────────────────────────────────────────────

  @SubscribeMessage('cast_vote')
  handleCastVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetName: string },
  ) {
    const room = this.roomService.getRoomBySocket(client.id);
    if (!room) return;
    const voter = room.players.find((p) => p.id === client.id);
    if (!voter) return;

    const result = this.roomService.castVote(room.code, voter.name, data.targetName);
    if (!result) return;

    this.server.to(room.code).emit('vote_update', result);

    // Auto-close if everyone voted
    if (result.votedCount >= result.totalCount) {
      this.handleCloseVotingInternal(room.code);
    }
  }

  @SubscribeMessage('retract_vote')
  handleRetractVote(@ConnectedSocket() client: Socket) {
    const room = this.roomService.getRoomBySocket(client.id);
    if (!room) return;
    const voter = room.players.find((p) => p.id === client.id);
    if (!voter) return;

    const result = this.roomService.retractVote(room.code, voter.name);
    if (!result) return;

    this.server.to(room.code).emit('vote_update', result);
  }

  @SubscribeMessage('close_voting')
  handleCloseVoting(@ConnectedSocket() client: Socket) {
    const room = this.roomService.getRoomBySocket(client.id);
    if (!room) return;
    this.handleCloseVotingInternal(room.code);
  }

  private handleCloseVotingInternal(roomCode: string) {
    const result = this.roomService.closeVoting(roomCode);
    if (!result) return; // already closed

    if (result.eliminated) {
      this.roomService.eliminatePlayerOnline(roomCode, result.eliminated);
    } else {
      this.roomService.advanceRound(roomCode);
    }

    this.server.to(roomCode).emit('voting_closed', result);
    this.logger.log(`Sala ${roomCode} → voting_closed (${result.reason}, eliminado: ${result.eliminated ?? 'nadie'})`);
  }

  @SubscribeMessage('play_again')
  handlePlayAgain(@ConnectedSocket() client: Socket) {
    const room = this.roomService.getRoomBySocket(client.id);
    if (!room) return;
    const player = room.players.find((p) => p.id === client.id);
    if (!player?.isHost) return; // only host can reset

    const resetRoom = this.roomService.resetRoom(room.code);
    if (!resetRoom) return;

    this.server.to(room.code).emit('room_reset', this.serializeRoom(resetRoom));
    this.logger.log(`Sala ${room.code} → room_reset por host "${player.name}"`);
  }

  private cancelCountdown(roomCode: string) {
    const timer = this.countdownTimers.get(roomCode);
    if (timer) {
      clearInterval(timer);
      this.countdownTimers.delete(roomCode);
      this.roomService.setCountdown(roomCode, null);
      this.server.to(roomCode).emit('countdown_cancelled');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private serializeRoom(room: ReturnType<typeof this.roomService.getRoom>) {
    if (!room) return null;
    return {
      code: room.code,
      players: room.players.map((p) => ({
        name: p.name,
        isHost: p.isHost,
        ready: p.ready,
      })),
      settings: room.settings,
      countdown: room.countdown,
    };
  }
}
