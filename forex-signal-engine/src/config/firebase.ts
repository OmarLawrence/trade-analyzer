import 'dotenv/config';
import { initializeApp, getApps, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId: 'project-tracker-33129',
  });
}

export const db = getFirestore();