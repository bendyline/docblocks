import { useEffect, useMemo, useRef, useState } from 'react';
import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';
import type {
  AiChatEvidence,
  AiChatKnowledge,
  AiFactCheck,
  AiFactCheckRequest,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

type ChatApi = Pick<DocBlocksHostAiAPI, 'chat'>;

/**
 * What several requests in one run drew on, as one indicator: any citation
 * wins, then any search, so a repair call cannot hide the first call's sources.
 */
export function mergeAiKnowledge(
  current: AiChatKnowledge | null,
  next: AiChatKnowledge,
): AiChatKnowledge {
  if (!current) return next;
  if (current.outcome !== 'used' || next.outcome !== 'used') {
    if (current.outcome === 'used') return current;
    if (next.outcome === 'used') return next;
    return current.outcome === 'none' ? current : next;
  }
  const sources = current.sources.map((source) => ({ ...source, titles: [...source.titles] }));
  for (const source of next.sources) {
    const existing = sources.find((entry) => entry.catalogId === source.catalogId);
    if (!existing) {
      sources.push({ ...source, titles: [...source.titles] });
      continue;
    }
    for (const title of source.titles) {
      if (!existing.titles.includes(title)) existing.titles.push(title);
    }
  }
  const evidence = [...current.evidence];
  for (const passage of next.evidence) {
    if (!evidence.some((known) => known.text === passage.text)) evidence.push(passage);
  }
  return { outcome: 'used', sources, evidence };
}

function sameEvidence(a: readonly AiChatEvidence[], b: readonly AiChatEvidence[]): boolean {
  return a.length === b.length && a.every((passage, index) => passage.text === b[index]?.text);
}

/**
 * Whether `next` keeps the run's `[n]` numbers meaning one passage each. A
 * continuation that retrieves different passages numbers them from 1 again.
 */
function numberingHolds(current: AiChatKnowledge | null, next: AiChatKnowledge): boolean {
  return (
    current?.outcome !== 'used' ||
    next.outcome !== 'used' ||
    sameEvidence(current.evidence, next.evidence)
  );
}

/**
 * Track what knowledge catalogs added to a run of requests. Send the run's
 * requests through the returned `ai`; `reset` starts a new run, and anything a
 * superseded run reports afterwards is ignored.
 */
export function useAiKnowledge(ai: ChatApi) {
  const [run, setRun] = useState<{ knowledge: AiChatKnowledge | null; citable: boolean }>({
    knowledge: null,
    citable: true,
  });
  const runRef = useRef(0);
  const helpers = useMemo(() => {
    const tapped: ChatApi = {
      chat(request, onEvent) {
        const started = runRef.current;
        return ai.chat(request, (event) => {
          if (event.kind === 'knowledge' && started === runRef.current) {
            setRun((current) => ({
              knowledge: mergeAiKnowledge(current.knowledge, event.knowledge),
              citable: current.citable && numberingHolds(current.knowledge, event.knowledge),
            }));
          }
          onEvent(event);
        });
      },
    };
    const reset = () => {
      runRef.current += 1;
      setRun({ knowledge: null, citable: true });
    };
    // `ai` and `reset` stay stable across renders, for effect and callback deps.
    return { ai: tapped, reset };
  }, [ai]);
  // `citable`: every `[n]` in the run's output means one known passage.
  return { knowledge: run.knowledge, citable: run.citable, ...helpers };
}

/**
 * A fact check of `text` against what its run was shown, or null when the
 * text is too long to check. Passages past the host's bounds are dropped,
 * which can only add flags, never hide one.
 */
export function factCheckRequest(
  text: string,
  knowledge: AiChatKnowledge | null,
  given: string,
  citable: boolean,
): AiFactCheckRequest | null {
  if (text.length > AI_WIRE_LIMITS.factCheckTextCharacters) return null;
  const evidence: string[] = [];
  let total = 0;
  for (const passage of knowledge?.outcome === 'used' ? knowledge.evidence : []) {
    total += passage.text.length;
    if (
      evidence.length >= AI_WIRE_LIMITS.factCheckEvidence ||
      total > AI_WIRE_LIMITS.factCheckEvidenceCharacters
    ) {
      break;
    }
    evidence.push(passage.text);
  }
  return {
    text,
    evidence,
    given: given.slice(0, AI_WIRE_LIMITS.factCheckGivenCharacters),
    // Passages were numbered for citing only when there were passages.
    citations: citable && evidence.length > 0,
  };
}

/**
 * Gezel's bar for refusing a document write, used here to ask first: any
 * unsourced year, number, month or quotation, or three sentences of unsourced
 * names. One stray name alone is too often a false alarm.
 */
export function factsNeedReview(check: AiFactCheck): boolean {
  return check.unsourced.some((sentence) => sentence.strong) || check.unsourced.length >= 3;
}

/**
 * Check `text` once it settles, and again after each pause in editing. The
 * last result stays on screen while the next is worked out.
 */
export function useFactCheck(
  ai: Pick<DocBlocksHostAiAPI, 'checkFacts'>,
  text: string | null,
  knowledge: AiChatKnowledge | null,
  given: string,
  citable: boolean,
): AiFactCheck | null {
  const [result, setResult] = useState<AiFactCheck | null>(null);
  useEffect(() => {
    const request =
      text?.trim() && ai.checkFacts ? factCheckRequest(text, knowledge, given, citable) : null;
    if (!request) {
      setResult(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      ai.checkFacts?.(request).then(
        (checked) => {
          if (live) setResult(checked.ok ? checked.value : null);
        },
        () => {
          if (live) setResult(null);
        },
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ai, text, knowledge, given, citable]);
  return result;
}
