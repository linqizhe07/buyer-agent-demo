export type DriverKind = "scripted" | "llm";

export interface RunArgs {
  /** run exactly one scenario */
  only?: string;
  /** resume from this scenario (the ones before it are skipped) */
  from?: string;
  /** open the control room and wait for a human at every card */
  live: boolean;
  /** wipe and reseed the DEFAULT home before running */
  fresh: boolean;
  driver: DriverKind;
  /** control-room port */
  port: number;
  /** overrides $BUYER_HOME */
  home?: string;
  /** keep the control room up after the last scenario (live mode) */
  hold: boolean;
  /** open the control room in a headless run too (watch the stand-in answer) */
  room: boolean;
}

export function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = { live: false, fresh: false, driver: "scripted", port: 4800, hold: false, room: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--only":
        args.only = next();
        break;
      case "--from":
        args.from = next();
        break;
      case "--live":
        args.live = true;
        break;
      case "--hold":
        args.hold = true;
        break;
      case "--room":
        args.room = true;
        break;
      case "--fresh":
        args.fresh = true;
        break;
      case "--driver": {
        const d = next();
        if (d !== "scripted" && d !== "llm") throw new Error(`--driver must be scripted or llm, got ${d}`);
        args.driver = d;
        break;
      }
      case "--port":
        args.port = Number(next());
        break;
      case "--home":
        args.home = next();
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (process.env.BUYER_DRIVER === "llm") args.driver = "llm";
  return args;
}
