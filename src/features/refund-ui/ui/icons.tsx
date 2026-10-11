/**
 * One small outline icon set: 16px canvas, 1.5px stroke, round caps, drawn in
 * currentColor so icons follow the text they sit next to. Always decorative;
 * the control that holds an icon carries the accessible name.
 */

import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function MenuIcon() {
  return (
    <Svg>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Svg>
  );
}

export function CloseIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function SendIcon() {
  return (
    <Svg>
      <path d="M8 13V3.5M4 7.5l4-4 4 4" />
    </Svg>
  );
}

export function FileIcon() {
  return (
    <Svg>
      <path d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75z" />
      <path d="M9 1.75v3.5h3.5" />
    </Svg>
  );
}

export function UploadIcon() {
  return (
    <Svg>
      <path d="M8 10.5V2.75M5 5.5l3-3 3 3" />
      <path d="M2.75 10v2.25a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V10" />
    </Svg>
  );
}

export function PhoneIcon() {
  return (
    <Svg>
      <path d="M5.6 2.5H3.75a1 1 0 0 0-1 1.08 10.5 10.5 0 0 0 9.67 9.67 1 1 0 0 0 1.08-1V10.4l-2.6-1.1-1.3 1.3a7.5 7.5 0 0 1-3.2-3.2l1.3-1.3L6.6 3.5" />
    </Svg>
  );
}

export function CheckIcon() {
  return (
    <Svg>
      <path d="M3 8.5l3.25 3L13 4.75" />
    </Svg>
  );
}

export function AlertIcon() {
  return (
    <Svg>
      <path d="M8 2.25L14.25 13H1.75L8 2.25z" />
      <path d="M8 6.5v2.75M8 11.25v.01" />
    </Svg>
  );
}

export function PlusIcon() {
  return (
    <Svg>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function ChevronRightIcon() {
  return (
    <Svg size={12}>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </Svg>
  );
}

export function DownloadIcon() {
  return (
    <Svg>
      <path d="M8 2.75v7.75M5 7.5l3 3 3-3" />
      <path d="M2.75 11v1.25a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V11" />
    </Svg>
  );
}
