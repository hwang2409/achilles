type Deliver<Outcome, Sent> = (outcome: Outcome, sent: Sent) => void;

/** Owns attempts by key and form identity, not their wire policy. Closing stops follow-up work, not a sent request. */
export function createWriteForms<Outcome, Sent>({ inProgress, unexpected, afterClose }: {
  inProgress: Outcome;
  unexpected: Outcome;
  afterClose?: Deliver<Outcome, Sent>;
}) {
  type Form = { abort: AbortController; deliver?: Deliver<Outcome, Sent>; held?: [Outcome, Sent] };
  const forms = new Map<string, Form>();
  const flights = new Map<string, { form: string; fingerprint: string; run: Promise<void> }>();
  let opened = 0;
  function deliver(state: Form, outcome: Outcome, sent: Sent) {
    if (state.deliver) state.deliver(outcome, sent);
    else state.held = [outcome, sent];
  }

  return {
    open: () => {
      const form = `form-${++opened}`;
      forms.set(form, { abort: new AbortController() });
      return form;
    },
    close: (form: string) => {
      forms.get(form)?.abort.abort();
      forms.delete(form);
    },
    /** Deliver a held outcome once, then listen for future outcomes. Returns detach. */
    attach: (form: string, listener: Deliver<Outcome, Sent>) => {
      const state = forms.get(form);
      if (!state) return () => {};
      state.deliver = listener;
      const held = state.held;
      state.held = undefined;
      if (held) listener(...held);
      return () => { if (state.deliver === listener) state.deliver = undefined; };
    },
    pending: (form: string) => [...flights.values()].some((flight) => flight.form === form),
    run(form: string, key: string, fingerprint: string, sent: Sent, attempt: (signal: AbortSignal) => Promise<Outcome | null>): Promise<void> {
      const state = forms.get(form);
      if (!state) return Promise.resolve();
      const flight = flights.get(key);
      if (flight?.form === form && flight.fingerprint === fingerprint) return flight.run;
      if (flight) return Promise.resolve(deliver(state, inProgress, sent));
      const signal = state.abort.signal;
      const run = attempt(signal).catch(() => unexpected).then((outcome) => {
        flights.delete(key);
        if (outcome === null) return;
        if (signal.aborted) afterClose?.(outcome, sent);
        else deliver(state, outcome, sent);
      });
      flights.set(key, { form, fingerprint, run });
      return run;
    },
  };
}
