import type { CodexModel } from "./protocol";

const PREFERRED_MODEL = "gpt-5.6-luna";
const PREFERRED_EFFORT = "medium";

export type AiSelection = { model: string; effort: string };

function supportsEffort(model: CodexModel, effort: string): boolean {
  return model.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === effort,
  );
}

export function defaultAiSelection(models: CodexModel[]): AiSelection | undefined {
  const model =
    models.find(
      (item) =>
        item.id === PREFERRED_MODEL && supportsEffort(item, PREFERRED_EFFORT),
    ) ?? models.find((item) => item.isDefault) ?? models[0];
  if (!model) return undefined;
  return {
    model: model.id,
    effort:
      model.id === PREFERRED_MODEL && supportsEffort(model, PREFERRED_EFFORT)
        ? PREFERRED_EFFORT
        : model.defaultReasoningEffort,
  };
}

export function effectiveAiSelection(
  models: CodexModel[],
  selected?: AiSelection,
): AiSelection | undefined {
  const model = selected && models.find((item) => item.id === selected.model);
  if (model)
    return {
      model: model.id,
      effort: supportsEffort(model, selected.effort)
        ? selected.effort
        : model.defaultReasoningEffort,
    };
  return defaultAiSelection(models);
}

export function modelSupportsEffort(model: CodexModel, effort: string): boolean {
  return supportsEffort(model, effort);
}
