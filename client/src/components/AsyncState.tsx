type StateMessageProps = {
  title: string;
  message?: string;
};

export function EmptyState({ title, message }: StateMessageProps) {
  return (
    <div className="state-message state-message-muted">
      <strong>{title}</strong>
      {message && <span>{message}</span>}
    </div>
  );
}

export function RequestErrorState({ title, message }: StateMessageProps) {
  return (
    <div className="state-message state-message-error" role="alert">
      <strong>{title}</strong>
      {message && <span>{message}</span>}
    </div>
  );
}
