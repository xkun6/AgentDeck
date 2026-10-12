import { SectionShell } from "./section-shell";
import { ModelsSection } from "./settings-models-section";

export function ModelsRoute() {
  return (
    <SectionShell title="模型">
      <ModelsSection />
    </SectionShell>
  );
}
