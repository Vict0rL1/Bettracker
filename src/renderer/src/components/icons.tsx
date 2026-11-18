interface IconProps {
  size?: number
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true
  } as const
}

export const PlusIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const DownloadIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
)

export const PencilIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
)

export const TrashIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
  </svg>
)

export const ChevronLeftIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m15 18-6-6 6-6" />
  </svg>
)

export const ChevronRightIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m9 18 6-6-6-6" />
  </svg>
)

export const ChevronDownIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)} className="chevron-down">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

/** A box with an arrow out of it: backups and files. */
export const ArchiveIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M3 7h18M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M4 3h16v4H4zM10 11h4" />
  </svg>
)

/** Three lines: the header's menu. */
export const MenuIcon = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
)

export const GlobeIcon = ({ size = 15 }: IconProps) => (
  <svg {...svgProps(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
)

export const SignOutIcon = ({ size = 15 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </svg>
)

export const CloseIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const UploadIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </svg>
)

export const SunIcon = ({ size = 15 }: IconProps) => (
  <svg {...svgProps(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

export const MoonIcon = ({ size = 15 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </svg>
)

export const ClockIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const SlidersIcon = ({ size = 15 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
  </svg>
)

export const SparkIcon = ({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)} strokeWidth={2.4}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M17 7h4v4" />
  </svg>
)

/** Up and down: more or less than before (beside the words that say so). */
export const ArrowUpIcon = ({ size = 12 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

export const ArrowDownIcon = ({ size = 12 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
)

/** A receipt with a torn foot: scanning one with AI. */
export const ReceiptIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </svg>
)

/** A payment card. */
export const CardIcon = ({ size = 14 }: IconProps) => (
  <svg {...svgProps(size)}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 10h19M6.5 15h4" />
  </svg>
)
