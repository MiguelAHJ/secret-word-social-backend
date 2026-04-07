import { Injectable, Logger } from '@nestjs/common';
import { Room, RoomPlayer, RoomSettings, VotingResult } from './room.types';

@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);
  private readonly rooms = new Map<string, Room>();

  /** Maps socket id → room code for fast lookup on disconnect */
  private readonly playerRooms = new Map<string, string>();

  createRoom(socketId: string, playerName: string): Room {
    const code = this.generateCode();
    const room: Room = {
      code,
      players: [
        { id: socketId, name: playerName, isHost: true, ready: false },
      ],
      settings: {
        impostorCount: 1,
        showRoleOnElimination: false,
        impostorHasClue: true,
      },
      countdown: null,
      votes: {},
      alivePlayers: [],
      votingClosed: false,
      firstSpeaker: '',
      roundNumber: 1,
    };
    this.rooms.set(code, room);
    this.playerRooms.set(socketId, code);
    this.logger.log(`Sala ${code} creada por "${playerName}" (${socketId})`);
    return room;
  }

  joinRoom(
    code: string,
    socketId: string,
    playerName: string,
  ): Room | { error: string } {
    const room = this.rooms.get(code);
    if (!room) return { error: 'Sala no encontrada' };
    if (room.players.length >= 8) return { error: 'La sala está llena' };
    if (room.countdown !== null) return { error: 'La partida está por iniciar' };

    const nameTaken = room.players.some(
      (p) => p.name.toLowerCase() === playerName.toLowerCase(),
    );
    if (nameTaken) return { error: 'Ese nombre ya está en uso' };

    room.players.push({
      id: socketId,
      name: playerName,
      isHost: false,
      ready: false,
    });
    this.playerRooms.set(socketId, code);
    this.logger.log(`"${playerName}" se unió a sala ${code}`);
    return room;
  }

  updateSettings(
    code: string,
    socketId: string,
    settings: Partial<RoomSettings>,
  ): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;

    const player = room.players.find((p) => p.id === socketId);
    if (!player?.isHost) return null;

    Object.assign(room.settings, settings);

    // Reset ready states when settings change
    for (const p of room.players) p.ready = false;
    room.countdown = null;

    this.logger.log(`Configuración actualizada en sala ${code}`);
    return room;
  }

  toggleReady(code: string, socketId: string): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;

    const player = room.players.find((p) => p.id === socketId);
    if (!player) return null;

    player.ready = !player.ready;
    this.logger.log(
      `"${player.name}" en sala ${code} → ${player.ready ? 'LISTO' : 'NO LISTO'}`,
    );
    return room;
  }

  allReady(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room || room.players.length < 3) return false;
    return room.players.every((p) => p.ready);
  }

  setCountdown(code: string, seconds: number | null): void {
    const room = this.rooms.get(code);
    if (room) room.countdown = seconds;
  }

  removePlayer(socketId: string): { room: Room; removed: RoomPlayer } | null {
    const code = this.playerRooms.get(socketId);
    if (!code) return null;

    const room = this.rooms.get(code);
    if (!room) return null;

    const idx = room.players.findIndex((p) => p.id === socketId);
    if (idx === -1) return null;

    const [removed] = room.players.splice(idx, 1);
    this.playerRooms.delete(socketId);

    // If room is empty, delete it
    if (room.players.length === 0) {
      this.rooms.delete(code);
      this.logger.log(`Sala ${code} eliminada (vacía)`);
      return { room, removed };
    }

    // If host left, promote next player
    if (removed.isHost && room.players.length > 0) {
      room.players[0].isHost = true;
      this.logger.log(
        `"${room.players[0].name}" es el nuevo anfitrión de sala ${code}`,
      );
    }

    // Cancel countdown if someone leaves
    room.countdown = null;
    for (const p of room.players) p.ready = false;

    this.logger.log(`"${removed.name}" salió de sala ${code}`);
    return { room, removed };
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomBySocket(socketId: string): Room | undefined {
    const code = this.playerRooms.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }

  // ── Game methods ─────────────────────────────────────────────────────────

  initGame(code: string, playerNames: string[], firstSpeaker: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.alivePlayers = [...playerNames];
    room.votes = {};
    room.votingClosed = false;
    room.firstSpeaker = firstSpeaker;
    room.roundNumber = 1;
  }

  castVote(
    code: string,
    voterName: string,
    targetName: string,
  ): { votedCount: number; totalCount: number } | null {
    const room = this.rooms.get(code);
    if (!room || room.votingClosed) return null;
    if (!room.alivePlayers.includes(targetName)) return null;
    if (voterName === targetName) return null;

    room.votes[voterName] = targetName;
    return {
      votedCount: Object.keys(room.votes).length,
      totalCount: room.alivePlayers.length,
    };
  }

  retractVote(
    code: string,
    voterName: string,
  ): { votedCount: number; totalCount: number } | null {
    const room = this.rooms.get(code);
    if (!room || room.votingClosed) return null;
    if (!room.votes[voterName]) return null;

    delete room.votes[voterName];
    return {
      votedCount: Object.keys(room.votes).length,
      totalCount: room.alivePlayers.length,
    };
  }

  closeVoting(code: string): VotingResult | null {
    const room = this.rooms.get(code);
    if (!room || room.votingClosed) return null;
    room.votingClosed = true;

    const tally: Record<string, number> = {};
    for (const targetName of Object.values(room.votes)) {
      tally[targetName] = (tally[targetName] ?? 0) + 1;
    }

    if (Object.keys(tally).length === 0) {
      return { eliminated: null, reason: 'no_votes', tally };
    }

    const maxVotes = Math.max(...Object.values(tally));
    const topCandidates = Object.keys(tally).filter((n) => tally[n] === maxVotes);

    if (topCandidates.length > 1) {
      return { eliminated: null, reason: 'tie', tally };
    }

    return { eliminated: topCandidates[0], reason: 'majority', tally };
  }

  eliminatePlayerOnline(code: string, playerName: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.alivePlayers = room.alivePlayers.filter((n) => n !== playerName);
    this.advanceRound(code);
  }

  advanceRound(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.votes = {};
    room.votingClosed = false;
    room.roundNumber++;
  }

  resetRoom(code: string): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.votes = {};
    room.alivePlayers = [];
    room.votingClosed = false;
    room.firstSpeaker = '';
    room.roundNumber = 1;
    for (const p of room.players) p.ready = false;
    return room;
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code: string;
    do {
      code = Array.from(
        { length: 5 },
        () => chars[Math.floor(Math.random() * chars.length)],
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }
}
