// The GraphQL documents DigitalOcean's panel sends, VERBATIM. The endpoint runs a safelist: a document it does not
// recognize is rejected with `PERSISTED_QUERY_NOT_FOUND` (HTTP 403), so these must match the registered text byte
// for byte — never trim an unread field, reformat one, or drop a `__typename`. Each carries the operation name the
// request must name and the panel bundle the document is registered under; both ride on the request.
//
// When DigitalOcean rotates a document, re-capture with `pnpm record` and copy the request body's `query` back here.

export type SafelistedQuery = {
  operationName: string
  // Sent as `apollographql-client-name` — the panel bundle the document is registered under.
  client: 'ui-projects' | 'ui-billing'
  document: string
}

export const Q_TEAM: SafelistedQuery = {
  operationName: 'GetTeamData',
  client: 'ui-projects',
  document: `query GetTeamData {
  getMe {
    current_context {
      uuid
      name
      avatar_initials
      avatar_color
      onboarding_step
      status
      subject_role {
        name
        description
        __typename
      }
      __typename
    }
    __typename
  }
}
`
}

export const Q_BILLING_SUMMARY: SafelistedQuery = {
  operationName: 'getBillingSummary',
  client: 'ui-billing',
  document: `query getBillingSummary {
  getBillingSummary {
    payment_due_date
    prepayment_amount
    total_usage_amount
    remaining_prepayment_amount
    past_due_amount
    credits_applied
    prepayments_applied
    estimated_due
    __typename
  }
}
`
}

export const Q_BILLING_INSIGHTS: SafelistedQuery = {
  operationName: 'getBillingInsightsSummary',
  client: 'ui-projects',
  document: `query getBillingInsightsSummary {
  getBillingInsightsSummary {
    insight
    current_mtd_spend
    action {
      route
      type
      label
      __typename
    }
    projected_month_spend
    daily_average_spend
    __typename
  }
}
`
}

export const Q_CREDITS: SafelistedQuery = {
  operationName: 'getBillingCredits',
  client: 'ui-projects',
  document: `query getBillingCredits {
  getBillingCreditsPublic {
    available_amount
    credits {
      is_new_user_credit
      is_growth_credit
      created_at
      expires_on
      initial_amount
      available_amount
      description
      __typename
    }
    __typename
  }
}
`
}

export const Q_HISTORY: SafelistedQuery = {
  operationName: 'listBillingHistory',
  client: 'ui-billing',
  document: `query listBillingHistory($listBillingHistoryRequest: ListBillingHistoryRequest) {
  listBillingHistory(ListBillingHistoryRequest: $listBillingHistoryRequest) {
    billing_history {
      description
      amount
      invoice_id
      invoice_uuid
      date
      type
      memo_id
      receipt_id
      project_spend_report_available
      account_urn
      __typename
    }
    meta {
      total
      __typename
    }
    __typename
  }
}
`
}

export const Q_INVOICE: SafelistedQuery = {
  operationName: 'getInvoiceCloudSummary',
  client: 'ui-billing',
  document: `query getInvoiceCloudSummary($getInvoiceCloudSummaryRequest: GetInvoiceCloudSummaryRequest) {
  getInvoiceCloudSummary(
    GetInvoiceCloudSummaryRequest: $getInvoiceCloudSummaryRequest
  ) {
    invoice_uuid
    billing_start
    issue_date
    invoice_generated_at
    usage_items {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    subtotal {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    discounts {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    credits {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    taxes {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    total {
      ...DisplayEntry
      sub_items {
        ...DisplayEntry
        sub_items {
          ...DisplayEntry
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment DisplayEntry on DisplayEntry {
  type
  description
  extra_detail
  amount
  __typename
}
`
}

export const Q_PAYMENT_METHODS: SafelistedQuery = {
  operationName: 'listPaymentMethods',
  client: 'ui-billing',
  document: `query listPaymentMethods {
  listPaymentMethods {
    wire_transfer_bank_accounts {
      id
      bank_name
      account_number
      routing_number
      swift_code
      __typename
    }
    default_payment_method
    payment_methods {
      id
      description
      type
      expiration_date
      is_default
      currency
      supported_currencies
      details {
        last_four
        brand
        wallet_type
        email
        bank_name
        is_verified
        __typename
      }
      address {
        name
        address_line_1
        address_line_2
        city
        region
        country
        postal_code
        __typename
      }
      brand
      external_id
      success_counter
      failure_counter
      created_at
      __typename
    }
    __typename
  }
}
`
}

export const Q_BILLING_ADDRESS: SafelistedQuery = {
  operationName: 'getBillingAddress',
  client: 'ui-billing',
  document: `query getBillingAddress {
  getBillingAddress {
    billing_address {
      address_line1
      address_line2
      city
      region
      country_iso2_code
      postal_code
      created_at
      updated_at
      __typename
    }
    __typename
  }
}
`
}

export const Q_TAX_STATUS: SafelistedQuery = {
  operationName: 'getTaxStatus',
  client: 'ui-billing',
  document: `query getTaxStatus {
  getTaxStatus {
    tax_supported
    tax_rate
    tax_name
    tax_location_name
    tax_country_iso2
    tax_country_iso3
    is_taxable_location
    is_taxable_user
    is_tax_id_supported
    tax_id
    us_tax_exempt_status
    is_tax_exempt_location
    tax_description
    tax_exempt_status
    tax_region
    is_supplemental_tax_id_supported
    __typename
  }
}
`
}

export const Q_FACET_USAGE: SafelistedQuery = {
  operationName: 'GetProductFacetUsage',
  client: 'ui-projects',
  document: `query GetProductFacetUsage($getProductFacetUsageRequest: LimitsV2GetProductFacetUsageRequest) {
  GetProductFacetUsage(GetProductFacetUsageRequest: $getProductFacetUsageRequest) {
    productUsage {
      facet
      usage
      error
      __typename
    }
    __typename
  }
}
`
}

export const Q_PRODUCT_LIMITS: SafelistedQuery = {
  operationName: 'GetProductLimits',
  client: 'ui-projects',
  document: `query GetProductLimits($getProductLimitsRequest: LimitsV2GetProductLimitsRequest) {
  GetProductLimits(GetProductLimitsRequest: $getProductLimitsRequest) {
    productLimits {
      facet
      limit
      restriction
      __typename
    }
    __typename
  }
}
`
}

export const Q_DAILY_SPEND: SafelistedQuery = {
  operationName: 'getBillingDailySpend',
  client: 'ui-projects',
  document: `query getBillingDailySpend($getBillingDailySpendRequest: GetBillingDailySpendRequest!) {
  getBillingDailySpend(GetBillingDailySpendRequest: $getBillingDailySpendRequest) {
    daily_spend {
      date
      amount
      __typename
    }
    __typename
  }
}
`
}
