/** Activity meals share KDS and pickup screens without pretending to be table orders. */
export interface ActivityServiceLine {
    id: string;
    taskId: string;
    registrationPublicId: string;
    mealId: string;
    number: number;
    location: string | null;
    activityTitle?: string;
    packageName?: string;
    productId: string;
    name: string;
    station: 'bar' | 'kitchen';
    quantity: number;
    startedQuantity: number;
    readyQuantity: number;
    takenQuantity: number;
    version: number;
    held?: boolean;
    stoppedQuantity?: number;
    discardedReadyQuantity?: number;
    remadeTakenQuantity?: number;
    sourceRef?: string;
    note?: string;
    selectionLabel?: string;
    status: 'active' | 'cancelled';
    createdAt: string;
}
export interface ActivityServiceView {
    pendingAddonCount?: number;
    registrationPublicId: string;
    activityPublicId?: string;
    activityTitle?: string;
    packageName?: string;
    purchaseKind?: string;
    hasMeal?: boolean;
    mealServiceStartsAt?: string;
    mealServiceEndsAt?: string;
    partySize: number;
    maxParticipants: number;
    reservedSeats: number;
    admittedCount: number;
    remainingAdmission: number;
    includesAdmission: boolean;
    paymentStatus: string;
    meal: null | {
        id: string;
        number: number;
        status: 'open' | 'closed';
        plaqueState: 'pending' | 'issued' | 'returned';
        location: string | null;
        lines: ActivityServiceLine[];
        issueNotes?: Array<{id:string;lineId:string;reason:string;employeeLabel:string|null;createdAt:string}>;
    };
}
export type ActivityDoorCommand = {
    action: 'admit' | 'redeem' | 'admit_and_redeem' | 'plaque_issued' | 'return_plaque' | 'restore_plaque' | 'recover' | 'update_location';
    arrivedCount?: number;
    location?: string;
    credential?: string;
};
export type ActivityProductionCommand = {
    action: 'start' | 'ready' | 'take' | 'undo_take';
    lines: Array<{
        lineId: string;
        quantity: number;
        expectedVersion: number;
    }>;
    receiptId?: string;
    physicalStillAtPickupPoint?: boolean;
};
export interface ActivityProductionResult {
    receiptId: string;
    action: ActivityProductionCommand['action'];
    lines: ActivityServiceLine[];
    command?: ActivityProductionCommand;
    source?: {
        kind: 'employee' | 'shared_pickup_device';
        id: string;
        label?: string;
    };
    canUndo?: boolean;
}
export interface ActivityPackageServiceConfig {
    maxParticipants: number;
    includesAdmission: boolean;
    mealOnlyFeeAmountMinor: number | null;
    products: Array<{
        productId: string;
        quantity: number;
    }>;
}
export interface ActivityPurchaseInput {
    activityPublicId: string;
    activityPackagePublicId?: string | null;
    parentRegistrationPublicId?: string | null;
    purchaseKind: 'admission_package' | 'meal_package' | 'single_dish';
    partySize: number;
    productId?: string;
    quantity?: number;
    cardProjectId?: string;
    termsAcknowledged: boolean;
    acknowledgedSafetyPolicyVersion: string;
    acknowledgedRefundPolicyVersion: string;
    idempotencyKey: string;
}

export interface ActivityPackageChoiceGroup { id:string;name:string;quantity:number;productIds:string[];options?:Array<{productId:string;name:string}> }
