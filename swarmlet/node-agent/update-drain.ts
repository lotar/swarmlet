/** Local inference bypasses the controller router, so it needs its own atomic admission gate. */
export class UpdateDrain {
  private active = 0;
  private draining = false;
  admit(): (() => void) | null {
    if (this.draining) return null;
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
  begin(): boolean {
    if (this.active) return false;
    this.draining = true;
    return true;
  }
  resume(): void { this.draining = false; }
}
