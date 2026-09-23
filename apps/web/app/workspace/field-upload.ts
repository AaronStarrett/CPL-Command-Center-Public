export type FieldUploadInput = {
  projectId: string;
  visitId: string;
  file: File;
  idempotencyKey: string;
  onProgress: (percent: number) => void;
  signal: AbortSignal;
};
export type FieldUpload = <T>(input: FieldUploadInput) => Promise<T>;

export class FieldUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FieldUploadError";
  }
}

/** Authentication comes from the current workspace descriptor, never document.cookie. */
export function uploadFieldPhoto<T>(
  input: FieldUploadInput,
  headers: { organizationId: string; csrfToken: string },
  createRequest: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<T> {
  if (!["image/jpeg", "image/png"].includes(input.file.type))
    return Promise.reject(
      new FieldUploadError(
        "CPL_FIELD_PHOTO_TYPE_INVALID",
        "Choose a JPEG or PNG image. Other formats are not supported yet.",
      ),
    );
  if (input.file.size < 1 || input.file.size > 12 * 1024 * 1024)
    return Promise.reject(
      new FieldUploadError(
        "CPL_FIELD_PHOTO_SIZE_INVALID",
        "Each image must contain data and be no larger than 12 MiB.",
      ),
    );
  if (input.signal.aborted)
    return Promise.reject(
      new FieldUploadError(
        "CPL_FIELD_UPLOAD_ABORTED",
        "Upload cancelled. The original file remains on your device.",
      ),
    );
  return new Promise<T>((resolve, reject) => {
    const xhr = createRequest();
    let settled = false;
    const abort = () => xhr.abort();
    function finish(error?: Error, value?: T) {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.upload.onprogress = null;
      if (error) reject(error);
      else resolve(value!);
    }
    xhr.open(
      "POST",
      `/api/cpl-field/projects/${encodeURIComponent(input.projectId)}/visits/${encodeURIComponent(input.visitId)}/photos`,
    );
    xhr.withCredentials = true;
    xhr.timeout = 90_000;
    xhr.setRequestHeader("Content-Type", input.file.type);
    xhr.setRequestHeader("X-CPL-CSRF", headers.csrfToken);
    xhr.setRequestHeader("X-CPL-Organization", headers.organizationId);
    xhr.setRequestHeader("X-CPL-Filename", encodeURIComponent(input.file.name));
    xhr.setRequestHeader("X-CPL-Idempotency-Key", input.idempotencyKey);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        input.onProgress(
          Math.min(100, Math.max(0, Math.floor((event.loaded / event.total) * 100))),
        );
    };
    xhr.onload = () => {
      let value: unknown;
      try {
        value = JSON.parse(xhr.responseText);
      } catch {
        finish(
          new FieldUploadError(
            "CPL_FIELD_UPLOAD_RESPONSE_INVALID",
            "The upload response was interrupted. Retry this same file to check its saved result.",
          ),
        );
        return;
      }
      if (xhr.status !== 201 && xhr.status !== 202) {
        const code =
          value &&
          typeof value === "object" &&
          typeof (value as { code?: unknown }).code === "string"
            ? (value as { code: string }).code
            : "CPL_FIELD_UPLOAD_FAILED";
        finish(
          new FieldUploadError(
            code,
            xhr.status === 413
              ? "The image exceeds the upload limit."
              : "The image could not be stored. Your file is kept for retry.",
          ),
        );
        return;
      }
      if (!value || typeof value !== "object") {
        finish(
          new FieldUploadError(
            "CPL_FIELD_UPLOAD_RESPONSE_INVALID",
            "The saved photo response was incomplete. Retry the same file.",
          ),
        );
        return;
      }
      finish(undefined, value as T);
    };
    xhr.onerror = () =>
      finish(
        new FieldUploadError(
          "CPL_FIELD_UPLOAD_NETWORK",
          "Upload interrupted. Retry the same file; it will keep its original upload identity.",
        ),
      );
    xhr.ontimeout = () =>
      finish(
        new FieldUploadError(
          "CPL_FIELD_UPLOAD_TIMEOUT",
          "Upload timed out. Retry the same file to confirm whether it was saved.",
        ),
      );
    xhr.onabort = () =>
      finish(
        new FieldUploadError(
          "CPL_FIELD_UPLOAD_ABORTED",
          "Upload cancelled. Retry to confirm its saved state.",
        ),
      );
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      input.onProgress(0);
      xhr.send(input.file);
    } catch {
      finish(
        new FieldUploadError(
          "CPL_FIELD_UPLOAD_FAILED",
          "The upload could not start. Your file is kept for retry.",
        ),
      );
    }
  });
}
