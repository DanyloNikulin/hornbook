import { StringDecoder } from 'node:string_decoder';

/** Each stdout/stderr stream gets its own bounded UTF-8 line decoder. */
export class JobEventStream {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private dropping = false;
  private carriageReturn = false;
  constructor(private readonly line: (line: string) => void) {}

  write(chunk: Buffer): void { this.append(this.decoder.write(chunk)); }
  end(): void {
    this.append(this.decoder.end());
    if (this.buffer && !this.dropping) this.line(this.buffer);
    this.buffer = '';
  }
  private append(text: string): void {
    for (const part of text.split(/([\r\n])/)) {
      if (!part) continue;
      if (part === '\r' || part === '\n') {
        if (!(part === '\n' && this.carriageReturn) && !this.dropping) this.line(this.buffer);
        this.buffer = ''; this.dropping = false;
        this.carriageReturn = part === '\r';
        continue;
      }
      this.carriageReturn = false;
      if (this.dropping) continue;
      this.buffer += part;
      if (this.buffer.length > 200_000) {
        this.line(this.buffer.slice(0, 200_000));
        this.buffer = ''; this.dropping = true;
      }
    }
  }
}
