/**
 * Number that tweens from its previous value to the new one (Framer Motion `animate`),
 * so scenario results visibly "count" to their new level. Honours prefers-reduced-motion
 * by jumping straight to the value. Non-finite values render through `format` untouched.
 */
import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import { isNum } from "../../lib/format.js";

/**
 * @param {object} props
 * @param {number|null} props.value
 * @param {(v: number|null) => string} props.format
 * @param {number} [props.duration] seconds
 */
export default function AnimatedNumber({ value, format, duration = 0.6 }) {
  const reduceMotion = useReducedMotion();
  const [display, setDisplay] = useState(value);
  // Last value actually shown, so an interrupted tween restarts from where it visibly is.
  const shown = useRef(value);

  useEffect(() => {
    const from = shown.current;
    const show = (v) => {
      shown.current = v;
      setDisplay(v);
    };
    if (reduceMotion || !isNum(value) || !isNum(from) || from === value) {
      show(value);
      return undefined;
    }
    const controls = animate(from, value, { duration, ease: [0.16, 1, 0.3, 1], onUpdate: show });
    return () => controls.stop();
  }, [value, duration, reduceMotion]);

  return <>{format(display)}</>;
}
