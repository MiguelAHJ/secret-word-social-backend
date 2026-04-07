export interface RoomPlayer {
  id: string;       // socket id
  name: string;
  isHost: boolean;
  ready: boolean;
}

export interface RoomSettings {
  impostorCount: number;
  showRoleOnElimination: boolean;
  impostorHasClue: boolean;
}

export interface Room {
  code: string;
  players: RoomPlayer[];
  settings: RoomSettings;
  countdown: number | null;
  // Game state (populated after game_starting)
  votes: Record<string, string>;  // voterName → targetName
  alivePlayers: string[];
  votingClosed: boolean;
  firstSpeaker: string;
  roundNumber: number;
}

export interface VotingResult {
  eliminated: string | null;
  reason: 'majority' | 'tie' | 'no_votes';
  tally: Record<string, number>;
}
