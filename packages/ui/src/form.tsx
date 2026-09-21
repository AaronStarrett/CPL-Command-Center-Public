"use client";

import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "./utils";

interface FormFieldContextValue {
  readonly describedBy?: string;
  readonly errorMessageId?: string;
}

const FormFieldContext = createContext<FormFieldContextValue>({});

function mergeIds(...ids: Array<string | undefined>): string | undefined {
  const merged = ids.filter(Boolean).join(" ");
  return merged || undefined;
}

export interface FormFieldProps {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
}

export function FormField({
  label,
  children,
  htmlFor,
  hint,
  error,
  required,
  className,
}: FormFieldProps) {
  const messageId = useId();
  const hintId = hint ? `${messageId}-hint` : undefined;
  const errorId = error ? `${messageId}-error` : undefined;

  return (
    <div className={cn("bea-form-field", className)}>
      <label className="bea-label" htmlFor={htmlFor}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <FormFieldContext.Provider
        value={{ describedBy: mergeIds(hintId, errorId), errorMessageId: errorId }}
      >
        {children}
      </FormFieldContext.Provider>
      {hint ? (
        <p id={hintId} className="bea-field-message">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="bea-field-message bea-field-message--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    invalid,
    id,
    "aria-describedby": ariaDescribedBy,
    "aria-errormessage": ariaErrorMessage,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const field = useContext(FormFieldContext);
  const computedInvalid = Boolean(invalid || field.errorMessageId);

  return (
    <input
      ref={ref}
      id={id ?? generatedId}
      className={cn("bea-input", computedInvalid && "bea-input--invalid", className)}
      aria-describedby={mergeIds(ariaDescribedBy, field.describedBy)}
      aria-errormessage={ariaErrorMessage ?? field.errorMessageId}
      aria-invalid={computedInvalid || undefined}
      {...props}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    invalid,
    id,
    children,
    "aria-describedby": ariaDescribedBy,
    "aria-errormessage": ariaErrorMessage,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const field = useContext(FormFieldContext);
  const computedInvalid = Boolean(invalid || field.errorMessageId);

  return (
    <select
      ref={ref}
      id={id ?? generatedId}
      className={cn("bea-select", computedInvalid && "bea-input--invalid", className)}
      aria-describedby={mergeIds(ariaDescribedBy, field.describedBy)}
      aria-errormessage={ariaErrorMessage ?? field.errorMessageId}
      aria-invalid={computedInvalid || undefined}
      {...props}
    >
      {children}
    </select>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    invalid,
    id,
    "aria-describedby": ariaDescribedBy,
    "aria-errormessage": ariaErrorMessage,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const field = useContext(FormFieldContext);
  const computedInvalid = Boolean(invalid || field.errorMessageId);

  return (
    <textarea
      ref={ref}
      id={id ?? generatedId}
      className={cn("bea-input", computedInvalid && "bea-input--invalid", className)}
      aria-describedby={mergeIds(ariaDescribedBy, field.describedBy)}
      aria-errormessage={ariaErrorMessage ?? field.errorMessageId}
      aria-invalid={computedInvalid || undefined}
      {...props}
    />
  );
});
