
// Declare here the list of features
export enum Feature {
  BILLING_SYNC_USERS,
  BILLING_CHECK_THRESHOLD_ON_STOP,
  BILLING_PREVENT_CUSTOMER_DELETION,
  PRINCING_NEW_MODEL
}

export default class FeatureToggles {
  // Comment out the features that you want to switch OFF
  static activeFeatures: Feature[] = [
    // Feature.BILLING_SYNC_USERS, - When switched OFF the sync of the user should be implicit (LAZY mode)
    Feature.BILLING_CHECK_THRESHOLD_ON_STOP,
    Feature.BILLING_PREVENT_CUSTOMER_DELETION,
    Feature.PRINCING_NEW_MODEL
  ];

  // Check whether the feature is active or not!
  public static isFeatureActive(feature: Feature): boolean {
    return FeatureToggles.activeFeatures.includes(feature);
  }
}
