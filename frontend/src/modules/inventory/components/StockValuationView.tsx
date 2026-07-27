import { useState, useEffect } from "react";
import { Table, Card, Tabs, Tag, Statistic, Row, Col, Spin, Alert, Button } from "antd";
import { DollarOutlined, HistoryOutlined, WarningOutlined, ReloadOutlined } from "@ant-design/icons";
import { getStockValuation, getStockAgeing, getNearExpiryAlerts } from "../api";

export function StockValuationView() {
  const [loading, setLoading] = useState(true);
  const [valuationData, setValuationData] = useState<any>(null);
  const [ageingData, setAgeingData] = useState<any>(null);
  const [expiryAlerts, setExpiryAlerts] = useState<any[]>([]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [val, age, exp] = await Promise.all([
        getStockValuation(),
        getStockAgeing(),
        getNearExpiryAlerts(90),
      ]);
      setValuationData(val);
      setAgeingData(age);
      setExpiryAlerts(exp);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: 50 }}>
        <Spin size="large" tip="Loading Valuation & Ageing Reports..." />
      </div>
    );
  }

  const valuationColumns = [
    { title: "Item Code", dataIndex: "item_code", key: "item_code", render: (c: string) => <strong>{c}</strong> },
    { title: "Item Name", dataIndex: "item_name", key: "item_name" },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Total Qty", dataIndex: "total_qty", key: "total_qty" },
    { title: "Moving Avg Cost", dataIndex: "moving_avg_cost", key: "moving_avg_cost", render: (v: number) => `$${v.toFixed(2)}` },
    { title: "Total Stock Value", dataIndex: "total_stock_value", key: "total_stock_value", render: (v: number) => <strong>${v.toFixed(2)}</strong> },
  ];

  const ageingColumns = [
    { title: "Item Code", dataIndex: "item_code", key: "item_code", render: (c: string) => <strong>{c}</strong> },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Batch No", dataIndex: "batch_no", key: "batch_no" },
    { title: "Days in Stock", dataIndex: "days_in_stock", key: "days_in_stock" },
    {
      title: "Age Bucket",
      dataIndex: "age_bucket",
      key: "age_bucket",
      render: (b: string) => {
        const color = b === "0-30" ? "green" : b === "31-60" ? "blue" : b === "61-90" ? "orange" : "red";
        return <Tag color={color}>{b} Days</Tag>;
      },
    },
    { title: "Expiry Date", dataIndex: "expiry_date", key: "expiry_date" },
    { title: "Days to Expiry", dataIndex: "days_to_expiry", key: "days_to_expiry" },
  ];

  const expiryColumns = [
    { title: "Item Code", dataIndex: "item_code", key: "item_code", render: (c: string) => <strong>{c}</strong> },
    { title: "Item Name", dataIndex: "item_name", key: "item_name" },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Batch No", dataIndex: "batch_no", key: "batch_no" },
    { title: "Expiry Date", dataIndex: "expiry_date", key: "expiry_date" },
    {
      title: "Days Remaining",
      dataIndex: "days_to_expiry",
      key: "days_to_expiry",
      render: (d: number) => <Tag color={d <= 30 ? "red" : d <= 60 ? "volcano" : "gold"}>{d} Days</Tag>,
    },
    { title: "Available Qty", dataIndex: "quantity", key: "quantity" },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Stock Valuation, Ageing & Expiry</h2>
        </Col>
        <Col>
          <Button icon={<ReloadOutlined />} onClick={loadAll}>Refresh Reports</Button>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} md={6}>
          <Card bordered>
            <Statistic
              title="Portfolio Valuation"
              value={valuationData?.total_portfolio_value || 0}
              precision={2}
              prefix={<DollarOutlined />}
              suffix="USD"
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered>
            <Statistic
              title="Fresh Stock (0-30 Days)"
              value={ageingData?.bucket_0_30_qty || 0}
              prefix={<HistoryOutlined style={{ color: "#52c41a" }} />}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered>
            <Statistic
              title="Aged Stock (90+ Days)"
              value={ageingData?.bucket_90_plus_qty || 0}
              valueStyle={{ color: "#cf1322" }}
              prefix={<HistoryOutlined style={{ color: "#cf1322" }} />}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card bordered>
            <Statistic
              title="Near-Expiry Alerts (&le;90d)"
              value={expiryAlerts?.length || 0}
              valueStyle={{ color: "#fa8c16" }}
              prefix={<WarningOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card bordered>
        <Tabs
          items={[
            {
              key: "valuation",
              label: "Stock Valuation",
              children: <Table dataSource={valuationData?.items || []} columns={valuationColumns} rowKey="item_id" pagination={{ pageSize: 10 }} />,
            },
            {
              key: "ageing",
              label: "Stock Ageing Report",
              children: <Table dataSource={ageingData?.items || []} columns={ageingColumns} rowKey="stock_id" pagination={{ pageSize: 10 }} />,
            },
            {
              key: "expiry",
              label: `Near Expiry Feed (${expiryAlerts.length})`,
              children: (
                <div>
                  <Alert message="Items listed below are expiring within 90 days. Prioritize issues using FEFO." type="warning" showIcon style={{ marginBottom: 16 }} />
                  <Table dataSource={expiryAlerts} columns={expiryColumns} rowKey="stock_id" pagination={{ pageSize: 10 }} />
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
