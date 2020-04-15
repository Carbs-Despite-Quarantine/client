import {BlackCard} from "cards";

export enum RoomState {
  "new" = 1,
  "choosingCards",
  "readingCards",
  "viewingWinner"
}

export class Room {
  id: number;
  token: string;
  state: RoomState;

  link: string | undefined;

  flaredUser: number | undefined;
  edition: string | undefined;
  rotateCzar: boolean | undefined;
  curPrompt: BlackCard | undefined;
  selectedResponse: number | undefined;

  messages: Record<number, Message> = {};

  constructor(id: number, token: string) {
    this.id = id;
    this.token = token;
    this.state = RoomState.new;
  }
}

export class Message {
  id: number;
  userId: number;
  content: string;
  isSystemMsg: boolean;
  likes: Array<number>;

  constructor(id: number, userId: number, content: string, isSystemMsg: boolean, likes: Array<number>) {
    this.id = id;
    this.userId = userId;
    this.content = content;
    this.isSystemMsg = isSystemMsg;
    this.likes = likes;
  }
}