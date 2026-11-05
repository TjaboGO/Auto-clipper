const STEP_LABELS: Record<string, string> = {
  queued: 'I kö',
  downloading: 'Laddar ner',
  transcribing: 'Transkriberar',
  analyzing: 'Analyserar',
  rendering: 'Renderar klipp',
  done: 'Klar',
  error: 'Fel',
};

const ORDER = ['queued', 'downloading', 'transcribing', 'analyzing', 'rendering', 'done'];

interface ProgressStep {
  step: string;
  message: string;
  at: string;
}

export function JobProgress({
  steps,
  isError,
  error,
}: {
  steps: ProgressStep[];
  isError: boolean;
  error?: string;
}) {
  const currentStep = steps[steps.length - 1]?.step ?? 'queued';
  const currentIndex = ORDER.indexOf(currentStep);

  return (
    <div className="bg-base-900 rounded-xl2 p-6 md:p-8">
      <div className="flex flex-wrap gap-2 mb-6">
        {ORDER.map((step, i) => (
          <div
            key={step}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${
              i < currentIndex
                ? 'bg-accent-600/30 text-accent-300'
                : i === currentIndex
                  ? 'bg-accent-500 text-white'
                  : 'bg-base-800 text-gray-500'
            }`}
          >
            {STEP_LABELS[step] ?? step}
          </div>
        ))}
      </div>

      {isError ? (
        <p className="text-red-400 text-sm">{error || 'Något gick fel.'}</p>
      ) : (
        <div className="space-y-1.5 max-h-64 overflow-y-auto text-sm text-gray-400">
          {steps
            .slice()
            .reverse()
            .map((s, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-600 shrink-0 tabular-nums">
                  {new Date(s.at).toLocaleTimeString('sv-SE')}
                </span>
                <span>{s.message}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
