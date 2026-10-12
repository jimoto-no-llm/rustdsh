export function eventIdentifier(event) {
  return event.event_id || `legacy-${event.sequence}`;
}

export const eventTargetId = (eventId) => `event-${eventId}`;
export const decisionTargetId = (questionId) =>
  `decision-${encodeURIComponent(questionId)}`;
export const annotationSnapshotId = (annotationId) =>
  `annotation-source-${annotationId}`;
