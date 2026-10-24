/**
 * i18n area: api — English. Moved verbatim out of ./api.ts so the Hebrew client bundle never
 * carries English: this module is reached only from ../en.ts, i.e. the English dictionary chunk
 * (components/i18n/EnglishI18nProvider.tsx) and the server. The types still come from the Hebrew source.
 */
import type { Widen } from "../types";
import type { apiHe } from "./api";

export const apiEn: Widen<typeof apiHe> = {
  common: {
    unauthenticated: "Not signed in",
    noPermission: "Permission denied",
    invalidRequest: "Invalid request",
    invalidRequestDot: "Invalid request.",
    noFileSelected: "No file selected",
    fileTooLarge15: "The file is too large (up to 15MB)",
    fileTooLargeMb: "The file is too large (up to {mb}MB)",
    heicUnsupported: "HEIC format is not supported. Retake the photo or convert it to JPG (in the camera settings: 'Most Compatible').",
    unsupportedFileType: "Unsupported file type (PDF, JPG or PNG required)",
  },
  auth: {
    messages: {
      rateLimited: "Too many attempts. Please wait a few minutes and try again.",
      missingCredentials: "Enter an email and a password",
      invalidCredentials: "The email or password is incorrect",
      invalidBody: "The request was not received. Please refresh the page and try again.",
      serverError: "Something went wrong on our side. Please try again in a moment.",
      serviceUnavailable: "The service is unavailable right now. Please try again later.",
      signupRejected: "We couldn't create the account. Please refresh the page and try again.",
      resetRequested: "If this address is registered with us, we've sent it a link to choose a new password. The link is valid for one hour.",
      resetDone: "Your password was updated. From now on, sign in with the new password.",
      tokenInvalid: "This link is not valid. Please request a new one.",
      tokenExpired: "This link has expired. Please request a new one.",
      tokenUsed: "This link was already used. Request a new one if needed.",
      tokenSuperseded: "A newer link was sent. Please use the latest link you received.",
      emailVerified: "Your email address is verified. Thank you!",
      verificationSent: "We've sent a verification link to your email address.",
      alreadyVerified: "Your email address is already verified.",
      featureUnavailable: "This option is not available yet.",
      loginLastAttemptWarning: "Note: you have one sign-in attempt left before a temporary 15-minute lock.",
    },
    loginLocked: "For security reasons, signing in with this email address is temporarily blocked after several failed attempts. You can try again in {left}.",
    lockOneMinute: "one minute",
    lockMinutes: "{minutes} minutes",
    invalidEmail: "Enter a valid email address",
    weakPassword: "The password must be at least {min} characters long",
    emailAlreadyRegistered: "This email address is already registered",
  },
  business: {
    nameRequired: "Enter a business name",
    nameLength: "The business name must be {min}–{max} characters long",
    productLinkRequired: "When product help is turned on, a full, valid link is required (including https:// or http://)",
    setup: {
      noContactDetails: "No phone, email or link — just what the business does, in your own words.",
      tooLong: "The text is too long — up to 500 characters.",
      saveFailed: "We couldn't save the answer. Please try again.",
      invalidAnswer: "The answer is not valid",
      conflict: "The answer was changed at the same time. Please try again.",
    },
  },
  content: {
    renderBriefRequired: "A detailed enough goal brief is missing — a video can't be built from the business profile alone.",
    videoPlanBriefRequired: "A detailed goal brief is missing. Go back to the setup step and fill in “What are we promoting” and “What stops customers” before creating a video.",
  },
  crm: {
    oneFileAtATime: "You can upload one file at a time",
  },
  dataTransfer: {
    unknownDomain: "This area is not supported for import",
    tokenMissing: "The check approval is missing. Please run the check again.",
    mappingInvalid: "The column mapping is not valid",
    decisionsInvalid: "The choices are not valid",
    analyzeFailed: "Analyzing the file failed. Please try again later.",
    previewFailed: "Checking the file failed. Please try again later.",
    importFailedPartial: "The import failed. If some rows were already created, running the same file again will complete only what is missing.",
    templateFailed: "Creating the template failed. Please try again later.",
    noTemplateForDomain: "There is no template for the requested area",
    exportTooLarge: "There is too much data for a single export. Choose fewer areas and try again.",
    exportFailed: "The export failed. Please try again later.",
    documents: {
      unknownFile: "A choice was made for a file that is not in the batch",
      decisionNotPermitted: "This file can't be imported",
      analyzeFailed: "Checking the files failed. Please try again later.",
      decisionsMissing: "The approved choices are missing",
      executeFailed: "Importing the files failed. Please try again later.",
      invalidRange: "The date range is not valid",
      startAfterEnd: "The start date is after the end date",
      noDocuments: "There are no documents to export in the selected range.",
      exportFailed: "Exporting the documents failed. Please try again later.",
    },
    historical: {
      previewTokenMissing: "The preview approval is missing",
      importFailed: "The import failed. Please try again later.",
      previewFailed: "Building the preview failed. Please try again later.",
      recordFailed: "Loading the document failed. Please try again later.",
      recordsFailed: "Loading the history failed. Please try again later.",
    },
  },
  documents: {
    notFound: "Document not found",
    invalidId: "Invalid document ID",
    loadFailed: "Error loading the document. Please try again later.",
    approve: {
      missingAmount: "A valid amount is required for financial approval",
      missingVendor: "A supplier name is required for financial approval",
      missingDirection: "A direction (income/expense) is required for financial approval",
      financialLocked: "This document was already approved and recorded financially. The record can only be changed through a controlled correction.",
      failed: "Error approving the document. Please try again later.",
    },
    process: {
      sourceMissing: "The source file was not found. Please upload it again.",
      failed: "Error processing the document. Please try again later.",
    },
    inbox: {
      periodFailed: "Error loading the period",
      invalidMonth: "Invalid month (format YYYY-MM)",
      invalidCursor: "Invalid page cursor",
      loadFailed: "Error loading the documents. Please try again later.",
    },
    upload: {
      duplicate: "It looks like this document was already uploaded",
      failed: "Error uploading the document. Please try again later.",
    },
  },
  gmail: {
    invalidConnectionId: "Invalid connectionId",
    accountNotFound: "Account not found",
    attachmentNotInMessage: "The attachment was not found in the message",
    attachmentEmpty: "The attachment is empty",
    reconnectRequired: "The Gmail connection has expired. Reconnect to continue.",
    importFailed: "Error importing the document. Please try again later.",
    syncFailed: "Error scanning emails. Please try again later.",
  },
  inboundEmail: {
    notConfigured: "Receiving documents by email is not set up yet.",
    noActiveAddress: "There is no active address to replace.",
    addressNotFound: "Address not found.",
    emailRequired: "Enter an email address.",
    emailInvalid: "The email address is not valid.",
    senderNotFound: "Sender not found.",
  },
  inbox: {
    attention: {
      waitingForReply: "The customer sent the last message; reply when it suits you.",
      pendingSuggestion: "There is a suggested reply that hasn't been sent or closed yet.",
      recentlyHandled: "The conversation was recently marked as closed.",
    },
  },
  inventory: {
    imageUploadUnavailable: "Product images can't be uploaded right now. Please try again later.",
  },
  payments: {
    currencyNotOffered: "A payment can't be requested in {currency} through the connected payment provider. Available: {allowed}.",
    currencyMustMatchInvoice: "A payment request for an invoice uses the invoice's currency ({currency}).",
    foreignCurrencyCollectionDisabled: "Collecting in {currency} isn't available yet. Payment requests can be made in {allowed} only.",
    foreignCurrencyRequiresProviderDocuments: "Collecting in {currency} is available only through CardCom, when CardCom issues the documents (set in the CardCom connection). Payment requests can be made in {allowed} only.",
  },
  pricing: {
    profitLow: "Low",
    profitOk: "OK",
    profitHigh: "High",
  },
};
