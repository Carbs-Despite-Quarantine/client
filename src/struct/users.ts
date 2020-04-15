export enum UserState {
  "idle" = 1,
  "choosing",
  "czar",
  "winner",
  "nextCzar",
  "winnerAndNextCzar",
  "inactive"
}

export class User {
  id: number;
  admin: boolean;
  state: UserState;

  icon: string | undefined;
  name: string | undefined;
  score: number;

  constructor(id: number, admin: boolean, state: UserState, icon: string | undefined, name: string | undefined, score: number) {
    this.id = id;
    this.admin = admin;
    this.state = state;
    this.icon = icon;
    this.name = name;
    this.score = score;
  }
}