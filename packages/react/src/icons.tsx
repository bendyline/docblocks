import type { SVGProps } from 'react';

const defaults: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function NewFileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...defaults} {...props}>
      {/* Page outline */}
      <path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5l-3.5-3.5Z" />
      {/* Fold */}
      <path d="M9.5 1.5V5H13" />
      {/* Plus sign */}
      <line x1="6.5" y1="10" x2="9.5" y2="10" />
      <line x1="8" y1="8.5" x2="8" y2="11.5" />
    </svg>
  );
}

export function NewFolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...defaults} {...props}>
      {/* Folder outline */}
      <path d="M2 3.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5Z" />
      {/* Plus sign */}
      <line x1="6" y1="8.5" x2="10" y2="8.5" />
      <line x1="8" y1="6.5" x2="8" y2="10.5" />
    </svg>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...defaults} {...props}>
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" />
      <polyline points="13.5 3 13.5 6.5 10 6.5" />
    </svg>
  );
}
