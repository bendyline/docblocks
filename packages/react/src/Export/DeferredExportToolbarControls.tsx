import { lazy, Suspense } from 'react';
import type {
  ExportDestinationAdapter,
  ExportToolbarControlsProps,
} from './ExportToolbarControls.js';

const ExportToolbarControlsImplementation = lazy(() =>
  import('./ExportToolbarControls.js').then((module) => ({
    default: module.ExportToolbarControls,
  })),
);

/** Public toolbar control with its editor-coupled implementation deferred. */
export function ExportToolbarControls(props: ExportToolbarControlsProps) {
  return (
    <Suspense fallback={null}>
      <ExportToolbarControlsImplementation {...props} />
    </Suspense>
  );
}

export type { ExportDestinationAdapter, ExportToolbarControlsProps };
