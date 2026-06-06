# Normalized BI Workbook AST Schema

This project uses an intermediate abstract syntax tree (AST) so Tableau `.twbx` metadata and Power BI `.pbix` metadata can be compared without binding the dashboard to either vendor's native file format.

## Workbook envelope

```json
{
  "workbook": {
    "name": "Executive Sales Overview",
    "source_file": "executive_sales_overview.twbx",
    "target_file": "executive_sales_overview.pbix",
    "format": "tableau-twbx | powerbi-pbix",
    "generated_by": "altimate-ai-ast-adapter",
    "ast_version": "0.1.0"
  },
  "nodes": []
}
```

## Node kinds

### data_source

Represents connection metadata and exposed fields.

```json
{
  "id": "ds_salesforce_orders",
  "kind": "data_source",
  "name": "Salesforce Orders",
  "connection": {
    "type": "salesforce",
    "server": "login.salesforce.com",
    "database": "sales_cloud",
    "schema": "orders"
  },
  "fields": ["order_id", "sales"]
}
```

### relationship

Represents model relationships/joins.

```json
{
  "id": "rel_orders_customers",
  "kind": "relationship",
  "name": "Orders to Customers",
  "from": "Orders.customer_id",
  "to": "Customers.customer_id",
  "cardinality": "many-to-one",
  "active": true
}
```

### calculation

Represents Tableau calculated fields or Power BI DAX measures. The `ast` field is the normalized expression tree used for semantic comparison.

```json
{
  "id": "calc_net_revenue",
  "kind": "calculation",
  "name": "Net Revenue",
  "expression_language": "tableau-calculation | dax",
  "expression": "SUM([Sales]) - SUM([Discount])",
  "ast": {
    "type": "binary_expression",
    "operator": "-",
    "left": { "type": "aggregate", "function": "SUM", "field": "Sales" },
    "right": { "type": "aggregate", "function": "SUM", "field": "Discount" }
  }
}
```

### visual

Represents worksheet/report visual metadata.

```json
{
  "id": "visual_top_products",
  "kind": "visual",
  "name": "Top 10 Products",
  "visual_type": "bar",
  "encodings": {
    "x": "Net Revenue",
    "y": "Product Name"
  },
  "sort": { "field": "Net Revenue", "direction": "desc" },
  "limit": 10
}
```

### filter

Represents filters, slicers, and parameters.

```json
{
  "id": "filter_order_date",
  "kind": "filter",
  "name": "Order Date",
  "field": "order_date",
  "filter_type": "relative_date",
  "default": "last_12_months"
}
```

## Altimate AI conversion contract

The converter script currently accepts pre-normalized AST JSON. The intended Altimate AI adapter contract is:

```text
.twbx / .pbix file
  -> Altimate AI file reader
  -> native metadata extraction
  -> normalized BI AST JSON
  -> AST comparison
  -> validation_results.csv
  -> dashboard
```

For real files, the Altimate AI adapter should emit the schema above for each workbook/report pair.
