import ChevronDown from './ChevronDown';

// A native <select> with the browser arrow removed (appearance-none) and the shared
// ChevronDown overlaid, so it shows the exact same dropdown symbol as Combobox.
//
// Props:
//   value, onChange, children — passed to the underlying <select>
//   className        — visual classes for the <select> (border, padding, dark mode, …)
//   wrapperClassName — layout classes for the wrapper (e.g. "flex-1 min-w-0")
export default function Select({ value, onChange, children, className = '', wrapperClassName = '', id, ...rest }) {
  return (
    <div className={`relative ${wrapperClassName}`}>
      <select
        id={id}
        value={value}
        onChange={onChange}
        className={`w-full appearance-none pr-8 ${className}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
    </div>
  );
}
