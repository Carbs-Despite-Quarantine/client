export class Card {
  id: number;
  text: string;

  constructor(id: number, text: string) {
    this.id = id;
    this.text = text;
  }
}

export class BlackCard extends Card {
  draw: number;
  pick: number;

  constructor(id: number, text: string, draw: number, pick: number) {
    super(id, text);
    this.draw = draw;
    this.pick = pick;
  }
}