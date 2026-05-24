export enum RoomTag {
  PuyoTet = 0,
  PuyoOnly = 1,
  TetOnly = 2,
  Casual = 3,
  Competitive = 4,
}

export interface Room {
  id: string;
  players: string[];
  roomName: string;
  maxPlayers: number;
  password?: string;
  tags: RoomTag[];
}
