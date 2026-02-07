export function uploadStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'uploading':
      return 'Uploading';
    case 'processing':
      return 'Saving';
    case 'completed':
      return 'Done';
    case 'retrying':
      return 'Retrying';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Failed';
    default:
      return status;
  }
}
