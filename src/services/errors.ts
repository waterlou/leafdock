// Structured error codes so routes can map status codes exactly, instead of
// sniffing message substrings (a "not found" inside a git error used to turn
// a 400-class failure into a 404 app_not_found).

export class ValidationError extends Error {
  constructor(message: string, public code: string = 'validation_error') {
    super(message);
    this.name = 'ValidationError';
  }
}

// Failures from the docker daemon / compose CLI. Distinct from internal_error
// so clients can tell "the infra broke" apart from "the server has a bug".
// `options` forwards Error's `cause`, which is where dockerode keeps the
// daemon's status code and response body.
export class DockerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DockerError';
  }
}
