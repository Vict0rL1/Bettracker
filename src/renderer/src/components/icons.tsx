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

export const CloseIcon = ({ size = 16 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const SparkIcon = ({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)} strokeWidth={2.4}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M17 7h4v4" />
  </svg>
)
