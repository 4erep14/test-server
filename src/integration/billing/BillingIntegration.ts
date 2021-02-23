import { BillingChargeInvoiceAction, BillingDataTransactionStart, BillingDataTransactionStop, BillingDataTransactionUpdate, BillingInvoice, BillingInvoiceDocument, BillingInvoiceItem, BillingInvoiceStatus, BillingTax, BillingUser, BillingUserSynchronizeAction } from '../../types/Billing';
import User, { UserStatus } from '../../types/User';

import BackendError from '../../exception/BackendError';
import { BillingSetting } from '../../types/Setting';
import BillingStorage from '../../storage/mongodb/BillingStorage';
import Constants from '../../utils/Constants';
import Logging from '../../utils/Logging';
import NotificationHandler from '../../notification/NotificationHandler';
import { Request } from 'express';
import { ServerAction } from '../../types/Server';
import SettingStorage from '../../storage/mongodb/SettingStorage';
import TenantStorage from '../../storage/mongodb/TenantStorage';
import Transaction from '../../types/Transaction';
import { UserInErrorType } from '../../types/InError';
import UserStorage from '../../storage/mongodb/UserStorage';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'BillingIntegration';

export default abstract class BillingIntegration<T extends BillingSetting> {

  protected readonly tenantID: string; // Assuming UUID or other string format ID
  protected settings: T;

  protected constructor(tenantID: string, settings: T) {
    this.tenantID = tenantID;
    this.settings = settings;
  }

  public async synchronizeUsers(): Promise<BillingUserSynchronizeAction> {
    await this.checkConnection();
    // Check
    const actionsDone: BillingUserSynchronizeAction = {
      inSuccess: 0,
      inError: 0
    };
    // Get users already in Billing synchronization error
    const usersBillingInError = await UserStorage.getUsersInError(this.tenantID,
      { errorTypes: [UserInErrorType.FAILED_BILLING_SYNCHRO] }, Constants.DB_PARAMS_MAX_LIMIT);
    actionsDone.inError = usersBillingInError.result.length;
    // Sync e-Mobility New Users with no billing data + e-Mobility Users that have been updated after last sync
    const newUsersToSyncInBilling = await UserStorage.getUsers(this.tenantID,
      { 'statuses': [UserStatus.ACTIVE], 'notSynchronizedBillingData': true },
      { ...Constants.DB_PARAMS_MAX_LIMIT, sort: { 'userID': 1 } });
    if (newUsersToSyncInBilling.count > 0) {
      // Process them
      Logging.logInfo({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SYNCHRONIZE_USERS,
        module: MODULE_NAME, method: 'synchronizeUsers',
        message: `${newUsersToSyncInBilling.count} new e-Mobility user(s) are going to be synchronized in the billing system`
      });
      for (const user of newUsersToSyncInBilling.result) {
        // Synchronize user
        try {
          await this.synchronizeUser(this.tenantID, user);
          Logging.logInfo({
            tenantID: this.tenantID,
            actionOnUser: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: 'Successfully synchronized in the billing system'
          });
          actionsDone.inSuccess++;
        } catch (error) {
          actionsDone.inError++;
          Logging.logError({
            tenantID: this.tenantID,
            actionOnUser: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: 'Failed to synchronize in the billing system',
            detailedMessages: { error: error.message, stack: error.stack }
          });
        }
      }
    }
    // Get recently updated customers from Billing application
    const userBillingIDsChangedInBilling = await this.getUpdatedUserIDsInBilling();
    // Synchronize e-Mobility User's Billing data
    if (userBillingIDsChangedInBilling.length > 0) {
      Logging.logInfo({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SYNCHRONIZE_USERS,
        module: MODULE_NAME, method: 'synchronizeUsers',
        message: `${userBillingIDsChangedInBilling.length} billing user(s) are going to be synchronized with e-Mobility users`
      });
      for (const userBillingIDChangedInBilling of userBillingIDsChangedInBilling) {
        // Get e-Mobility User
        const user = await UserStorage.getUserByBillingID(this.tenantID, userBillingIDChangedInBilling);
        if (!user) {
          actionsDone.inError++;
          Logging.logError({
            tenantID: this.tenantID,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: `Billing user with ID '${userBillingIDChangedInBilling}' does not exist in e-Mobility`
          });
          continue;
        }
        // Get Billing User
        const billingUser = await this.getUser(userBillingIDChangedInBilling);
        if (!billingUser) {
          // Only triggers an error if e-Mobility user is not deleted
          actionsDone.inError++;
          user.billingData.hasSynchroError = true;
          await UserStorage.saveUserBillingData(this.tenantID, user.id, user.billingData);
          Logging.logError({
            tenantID: this.tenantID,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            actionOnUser: user,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: `Billing user with ID '${userBillingIDChangedInBilling}' does not exist in billing system`
          });
          continue;
        }
        // Synchronize several times the user in case of fail before setting it in error
        try {
          await this.synchronizeUser(this.tenantID, user);
          Logging.logInfo({
            tenantID: this.tenantID,
            actionOnUser: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: 'Successfully synchronized in the billing system'
          });
          actionsDone.inSuccess++;
        } catch (error) {
          actionsDone.inError++;
          Logging.logError({
            tenantID: this.tenantID,
            actionOnUser: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_USERS,
            module: MODULE_NAME, method: 'synchronizeUsers',
            message: 'Failed to synchronize in the billing system'
          });
        }
      }
    }
    // Log
    Logging.logActionsResponse(this.tenantID, ServerAction.BILLING_SYNCHRONIZE_USERS,
      MODULE_NAME, 'synchronizeUsers', actionsDone,
      '{{inSuccess}} user(s) were successfully synchronized',
      '{{inError}} user(s) failed to be synchronized',
      '{{inSuccess}} user(s) were successfully synchronized and {{inError}} failed to be synchronized',
      'All the users are up to date'
    );
    // Update last synchronization
    const billingSettings = await SettingStorage.getBillingSettings(this.tenantID);
    billingSettings.stripe.usersLastSynchronizedOn = new Date();
    await SettingStorage.saveBillingSettings(this.tenantID, billingSettings);
    // Result
    return actionsDone;
  }

  public async synchronizeUser(tenantID: string, user: User): Promise<void> {
    const exists = await this.userExists(user);
    let newUser: BillingUser;
    if (!exists) {
      newUser = await this.createUser(user);
    } else {
      newUser = await this.updateUser(user);
    }
    await UserStorage.saveUserBillingData(tenantID, user.id, newUser.billingData);
  }

  public async forceSynchronizeUser(user: User): Promise<void> {
    let billingUser = await this.getUserByEmail(user.email);
    if (billingUser) {
      if (user.billingData) {
        // Only override user's customerID
        user.billingData.customerID = billingUser.billingData.customerID;
        user.billingData.hasSynchroError = false;
      } else {
        billingUser = await this.updateUser(user);
        user.billingData = billingUser.billingData;
      }
    } else {
      user.billingData = (await this.createUser(user)).billingData;
    }
    // Save
    await UserStorage.saveUserBillingData(this.tenantID, user.id, user.billingData);
    Logging.logInfo({
      tenantID: this.tenantID,
      source: Constants.CENTRAL_SERVER,
      action: ServerAction.BILLING_FORCE_SYNCHRONIZE_USER,
      actionOnUser: user,
      module: MODULE_NAME, method: 'forceSynchronizeUser',
      message: `Successfully forced the synchronization of the user '${user.email}'`,
    });
  }

  public async synchronizeInvoices(user?: User): Promise<BillingUserSynchronizeAction> {
    let billingUser: BillingUser = null;
    const actionsDone: BillingUserSynchronizeAction = {
      inSuccess: 0,
      inError: 0
    };
    await this.checkConnection();
    // Check billing user
    if (user) {
      billingUser = await this.checkAndGetBillingUser(user);
    }
    // Get recently updated invoices from Billing application
    let invoiceIDsInBilling: string[];
    if (billingUser) {
      billingUser.billingData = user.billingData;
      // Get user's invoices
      invoiceIDsInBilling = await this.getUpdatedInvoiceIDsInBilling(billingUser);
    } else {
      // Get all invoices
      invoiceIDsInBilling = await this.getUpdatedInvoiceIDsInBilling();
    }
    if (invoiceIDsInBilling && invoiceIDsInBilling.length > 0) {
      Logging.logInfo({
        tenantID: this.tenantID,
        user: user,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
        module: MODULE_NAME, method: 'synchronizeInvoices',
        message: `${invoiceIDsInBilling.length} billing invoice(s) are going to be synchronized with e-Mobility invoices`
      });
      for (const invoiceIDInBilling of invoiceIDsInBilling) {
        try {
          // Get billing invoice
          const invoiceInBilling = await this.getInvoice(invoiceIDInBilling);
          // Get e-Mobility invoice
          const invoice = await BillingStorage.getInvoiceByBillingInvoiceID(this.tenantID, invoiceIDInBilling);
          if (!invoiceInBilling && !invoice) {
            actionsDone.inError++;
            Logging.logError({
              tenantID: this.tenantID,
              user: user,
              source: Constants.CENTRAL_SERVER,
              action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
              module: MODULE_NAME, method: 'synchronizeInvoices',
              message: `Billing invoice with ID '${invoiceIDInBilling}' does not exist`
            });
            continue;
          }
          // Delete in e-Mobility
          if (!invoiceInBilling && invoice) {
            await BillingStorage.deleteInvoiceByInvoiceID(this.tenantID, invoiceIDInBilling);
            actionsDone.inSuccess++;
            Logging.logDebug({
              tenantID: this.tenantID,
              user: user,
              source: Constants.CENTRAL_SERVER,
              action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
              module: MODULE_NAME, method: 'synchronizeInvoices',
              message: `Billing invoice with ID '${invoiceIDInBilling}' has been deleted in e-Mobility`
            });
            continue;
          }
          // Create / Update
          let userInInvoice: User;
          if (invoice) {
            // If invoice already exists, set back its e-Mobility ID before saving
            invoiceInBilling.id = invoice.id;
          }
          // Associate e-Mobility user to invoice according to invoice customer ID
          if (user) {
            // Can only be the invoice of the user
            userInInvoice = user;
          } else {
            // Get user
            userInInvoice = await UserStorage.getUserByBillingID(this.tenantID, invoiceInBilling.customerID);
          }
          // Check User
          if (!userInInvoice) {
            actionsDone.inError++;
            Logging.logError({
              tenantID: this.tenantID,
              user: user,
              source: Constants.CENTRAL_SERVER,
              action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
              module: MODULE_NAME, method: 'synchronizeInvoices',
              message: `No user found for billing invoice with ID '${invoiceIDInBilling}'`
            });
            continue;
          }
          // Set user
          invoiceInBilling.user = userInInvoice;
          invoiceInBilling.userID = userInInvoice.id;
          invoiceInBilling.downloadable = invoice ? invoice.downloadable : false;
          // Save invoice
          invoiceInBilling.id = await BillingStorage.saveInvoice(this.tenantID, invoiceInBilling);
          // Download the invoice document
          if (!invoice || !invoiceInBilling.downloadable || (invoice.nbrOfItems !== invoiceInBilling.nbrOfItems)) {
            const invoiceDocument = await this.downloadInvoiceDocument(invoiceInBilling);
            if (invoiceDocument) {
              // Save it
              await BillingStorage.saveInvoiceDocument(this.tenantID, invoiceDocument);
              // Update
              invoiceInBilling.downloadable = true;
              await BillingStorage.saveInvoice(this.tenantID, invoiceInBilling);
            }
          }
          // Save last User invoice sync
          userInInvoice.billingData.invoicesLastSynchronizedOn = new Date();
          await UserStorage.saveUserBillingData(this.tenantID, userInInvoice.id, userInInvoice.billingData);
          // Ok
          actionsDone.inSuccess++;
          Logging.logDebug({
            tenantID: this.tenantID,
            user: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
            module: MODULE_NAME, method: 'synchronizeInvoices',
            message: `Invoice with ID '${invoiceIDInBilling}' has been ${invoice ? 'updated' : 'created'} in e-Mobility`,
            detailedMessages: { invoiceInBilling }
          });
        } catch (error) {
          actionsDone.inError++;
          Logging.logError({
            tenantID: this.tenantID,
            user: user,
            source: Constants.CENTRAL_SERVER,
            action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
            module: MODULE_NAME, method: 'synchronizeInvoices',
            message: `Unable to process the invoice with ID '${invoiceIDInBilling}'`,
            detailedMessages: { error: error.message, stack: error.stack, invoiceIDInBilling }
          });
        }
      }
    }
    // Log
    Logging.logActionsResponse(this.tenantID, ServerAction.BILLING_SYNCHRONIZE_INVOICES,
      MODULE_NAME, 'synchronizeInvoices', actionsDone,
      '{{inSuccess}} invoice(s) were successfully synchronized',
      '{{inError}} invoice(s) failed to be synchronized',
      '{{inSuccess}} invoice(s) were successfully synchronized and {{inError}} failed to be synchronized',
      'All the invoices are up to date'
    );
    if (!user) {
      // Update global last synchronization timestamp
      const billingSettings = await SettingStorage.getBillingSettings(this.tenantID);
      billingSettings.stripe.invoicesLastSynchronizedOn = new Date();
      await SettingStorage.saveBillingSettings(this.tenantID, billingSettings);
    }
    return actionsDone;
  }

  public async chargeInvoices(): Promise<BillingChargeInvoiceAction> {
    const actionsDone: BillingChargeInvoiceAction = {
      inSuccess: 0,
      inError: 0
    };
    await this.checkConnection();

    const openedInvoices = await BillingStorage.getInvoicesToPay(this.tenantID);
    // Let's now try to pay opened invoices
    for (const openInvoice of openedInvoices.result) {
      // Synchronize user
      try {
        await this.chargeInvoice(openInvoice);
        // TODO - update the billing invoice state to reflect the change?
        Logging.logInfo({
          tenantID: this.tenantID,
          source: Constants.CENTRAL_SERVER,
          action: ServerAction.BILLING_CHARGE_INVOICE,
          module: MODULE_NAME, method: 'chargeInvoices',
          message: `Succesfully charge invoice '${openInvoice.id}'`
        });
        actionsDone.inSuccess++;
      } catch (error) {
        actionsDone.inError++;
        Logging.logError({
          tenantID: this.tenantID,
          source: Constants.CENTRAL_SERVER,
          action: ServerAction.BILLING_SYNCHRONIZE_USERS,
          module: MODULE_NAME, method: 'chargeInvoices',
          message: `Failed to charge invoice '${openInvoice.id}'`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    return actionsDone;
  }

  public async sendInvoiceToUser(invoice: BillingInvoice): Promise<BillingInvoice> {
    // Send link to the user using our notification framework (link to the front-end + download)
    const tenant = await TenantStorage.getTenant(this.tenantID);
    // Send async notification
    NotificationHandler.sendBillingNewInvoiceNotification(
      this.tenantID,
      invoice.id,
      invoice.user,
      {
        user: invoice.user,
        evseDashboardInvoiceURL: Utils.buildEvseBillingInvoicesURL(tenant.subdomain),
        evseDashboardURL: Utils.buildEvseURL(tenant.subdomain),
        invoiceDownloadUrl: Utils.buildEvseBillingDownloadInvoicesURL(tenant.subdomain, invoice.id),
        invoice: invoice
      }
    ).catch(() => { });
    return invoice;
  }

  public checkStopTransaction(transaction: Transaction): void {
    // Check User
    if (!transaction.userID || !transaction.user) {
      throw new BackendError({
        message: 'User is not provided',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'checkStopTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
    // Check Charging Station
    if (!transaction.chargeBox) {
      throw new BackendError({
        message: 'Charging Station is not provided',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'checkStopTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
    // Check Charging Station
    if (transaction?.billingData.invoiceID) {
      throw new BackendError({
        message: 'Transaction has already billing data',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'checkStopTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
    if (!transaction.user.billingData) {
      throw new BackendError({
        message: 'User has no Billing Data',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'checkStopTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
  }

  public checkStartTransaction(transaction: Transaction): void {
    // Check User
    if (!transaction.userID || !transaction.user) {
      throw new BackendError({
        message: 'User is not provided',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'startTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
    // Get User
    const billingUser = transaction.user;
    if (!billingUser.billingData || !billingUser.billingData.customerID) {
      throw new BackendError({
        message: 'Transaction user has no billing method or no customer in Stripe',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'startTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
  }

  private async checkAndGetBillingUser(user: User): Promise<BillingUser> {
    const billingUser = await this.getUserByEmail(user.email);
    if (!billingUser) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        user: user,
        module: MODULE_NAME, method: 'synchronizeInvoices',
        action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
        message: 'User does not exist in billing system',
        detailedMessages: { user, billingUser }
      });
    }
    // Check billing user data
    if (!billingUser.billingData || !billingUser.billingData.customerID) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        user: user,
        module: MODULE_NAME, method: 'synchronizeInvoices',
        action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
        message: 'User has no billing data in billing system',
        detailedMessages: { user, billingUser }
      });
    }
    if (!user.billingData || !user.billingData.customerID) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        user: user,
        module: MODULE_NAME, method: 'synchronizeInvoices',
        action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
        message: 'User has no billing data in e-Mobility',
        detailedMessages: { user, billingUser }
      });
    }
    if (user.billingData.customerID !== billingUser.billingData.customerID) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        user: user,
        module: MODULE_NAME, method: 'synchronizeInvoices',
        action: ServerAction.BILLING_SYNCHRONIZE_INVOICES,
        message: 'User has not the billing data in e-Mobility and in the billing system',
        detailedMessages: { user, billingUser }
      });
    }
    return billingUser;
  }

  abstract checkConnection(): Promise<void>;

  abstract getUpdatedUserIDsInBilling(): Promise<string[]>;

  abstract startTransaction(transaction: Transaction): Promise<BillingDataTransactionStart>;

  abstract updateTransaction(transaction: Transaction): Promise<BillingDataTransactionUpdate>;

  abstract stopTransaction(transaction: Transaction): Promise<BillingDataTransactionStop>;

  abstract checkIfUserCanBeCreated(user: User): Promise<boolean>;

  abstract checkIfUserCanBeUpdated(user: User): Promise<boolean>;

  abstract checkIfUserCanBeDeleted(user: User): Promise<boolean>;

  abstract getUser(id: string): Promise<BillingUser>;

  abstract getUserByEmail(email: string): Promise<BillingUser>;

  abstract getUsers(): Promise<BillingUser[]>;

  abstract createUser(user: User): Promise<BillingUser>;

  abstract updateUser(user: User): Promise<BillingUser>;

  abstract deleteUser(user: User): Promise<void>;

  abstract userExists(user: User): Promise<boolean>;

  abstract getTaxes(): Promise<BillingTax[]>;

  abstract getInvoice(id: string): Promise<BillingInvoice>;

  abstract getUpdatedInvoiceIDsInBilling(billingUser?: BillingUser): Promise<string[]>;

  abstract createInvoiceItem(user: BillingUser, invoiceID: string, invoiceItem: BillingInvoiceItem, idempotencyKey?: string | number): Promise<BillingInvoiceItem>;

  // eslint-disable-next-line max-len
  abstract createInvoice(user: BillingUser, invoiceItem: BillingInvoiceItem, idempotencyKey?: string | number): Promise<{ invoice: BillingInvoice; invoiceItem: BillingInvoiceItem }>;

  abstract downloadInvoiceDocument(invoice: BillingInvoice): Promise<BillingInvoiceDocument>;

  abstract finalizeInvoice(invoice: BillingInvoice): Promise<string>;

  // ##CR - TO BE CLARIFIED - clarify the return type!
  abstract attachPaymentMethod(user: User, paymentMethodId: string): Promise<unknown>;
  abstract chargeInvoice(invoice: BillingInvoice): Promise<unknown>;
  abstract handleBillingEvent(req: Request): boolean;

}
