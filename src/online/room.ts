export enum RoomTag {
  PuyoTet = 0,
  PuyoOnly = 1,
  TetOnly = 2,
  Casual = 3,
  Competitive = 4,
}

export const AllTags: RoomTag[] = [
  RoomTag.PuyoTet,
  RoomTag.PuyoOnly,
  RoomTag.TetOnly,
  RoomTag.Casual,
  RoomTag.Competitive,
] as const;

export const getTagName = (tag: RoomTag): string => {
  switch (tag) {
    case RoomTag.PuyoTet:
      return "ぷよテト";
    case RoomTag.PuyoOnly:
      return "ぷよのみ";
    case RoomTag.TetOnly:
      return "テトのみ";
    case RoomTag.Casual:
      return "カジュアル";
    case RoomTag.Competitive:
      return "ガチ";
    default:
      return "不明なタグ";
  }
};

export interface Room {
  id: string;
  players: string[];
  roomName: string;
  maxPlayers: number;
  password?: string;
  tags: RoomTag[];
}
